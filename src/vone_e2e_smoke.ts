import { createHash } from 'node:crypto';
import { redactSecrets } from './core/vone_secret_redaction';
import { VOneSessionHydrationEngine } from './core/vone_session_hydration_engine';
import {
    TransportError,
    type ClaimRequest,
    type ClaimResponse,
    type ExecutorJobOutput,
    type HeartbeatRequest,
    type HeartbeatResponse,
    type JobEnvelope,
    type MasterTransport,
    type ResultAck,
    type ResultSubmission,
} from './server/vone_execution_contract';
import { HttpMasterTransport } from './server/vone_http_master_transport';
import { SandboxResultLedger, type LedgerEntry, type TickOutcome } from './server/vone_master_worker';
import { WorkerConfigError, loadWorkerConfig, type WorkerConfig } from './server/vone_worker_config';
import { createWorkerFromConfig, type ComposedWorker, type WorkerDependencies } from './server/vone_worker_factory';

/**
 * E2E smoke runner: one real pass of
 * Master -> heartbeat -> claim -> VOneExecutor/VOneAgentLoop -> result,
 * using the normal worker and configuration, then an independent check of
 * the evidence before calling it PASS. It takes at most one job, and only
 * `vone_executor_execute`: any other toolName is left unexecuted and
 * unsubmitted (R1 has no unclaim, so it stays claimed on the Master) and the
 * run ends HOLD. It prints one JSON line of non-secret metadata - never job
 * args, model output, or any token.
 *
 * Exit codes: 0 PASS, 2 HOLD, 77 auth rejected, 78 configuration refused, 1 unexpected.
 */

export type SmokeVerdict = 'PASS' | 'HOLD' | 'FAIL_CLOSED';

export interface EvidenceCheck {
    readonly verdict: 'PASS' | 'HOLD';
    readonly checks: Readonly<Record<string, boolean>>;
    readonly failed: readonly string[];
}

/**
 * PASS only if the Master accepted a DONE result whose evidence verdict is
 * PASS, every hash re-verifies against the output and the files on disk, and
 * the session checkpoint agrees with what was reported. Anything else is HOLD.
 */
export function evaluateSmokeEvidence(input: {
    readonly entry: LedgerEntry | undefined;
    readonly checkpoint: { status?: unknown; checkpointRevision?: unknown; artifacts?: unknown } | null;
    readonly readArtifact: (path: string) => string | null;
}): EvidenceCheck {
    const result = input.entry?.result;
    const output = result?.output.kind === 'executor' ? (result.output as ExecutorJobOutput) : null;
    const artifacts = output?.artifacts ?? [];
    const checkpointArtifacts = Array.isArray(input.checkpoint?.artifacts)
        ? (input.checkpoint!.artifacts as Array<{ path?: unknown; sha256?: unknown }>).map((a) => ({ path: a.path, sha256: a.sha256 }))
        : null;

    const checks: Record<string, boolean> = {
        master_accepted: input.entry?.state === 'SUBMITTED',
        status_done: result?.status === 'DONE',
        executor_output: output !== null,
        evidence_verdict_pass: result?.evidence.verdict === 'PASS',
        output_hash_valid:
            !!result && /^[0-9a-f]{64}$/.test(result.evidence.output_sha256) && result.evidence.output_sha256 === sha256(stableStringify(result.output)),
        artifact_hashes_match_output:
            artifacts.length > 0 &&
            !!result &&
            JSON.stringify(result.evidence.artifact_hashes) === JSON.stringify(artifacts.map((artifact) => artifact.sha256)),
        artifacts_on_disk_match:
            artifacts.length > 0 &&
            artifacts.every((artifact) => {
                const content = input.readArtifact(artifact.path);
                return content !== null && sha256(content) === artifact.sha256;
            }),
        checkpoint_present: input.checkpoint?.status === 'DONE',
        checkpoint_coherent:
            !!output &&
            output.local_checkpoint_revision > 0 &&
            input.checkpoint?.checkpointRevision === output.local_checkpoint_revision &&
            JSON.stringify(checkpointArtifacts) === JSON.stringify(artifacts.map((a) => ({ path: a.path, sha256: a.sha256 }))),
    };
    const failed = Object.keys(checks).filter((key) => !checks[key]);
    return { verdict: failed.length === 0 ? 'PASS' : 'HOLD', checks, failed };
}

/** Takes at most one job, and only vone_executor_execute; records non-secret heartbeat/claim metadata. */
class SmokeTransport implements MasterTransport {
    public heartbeats = 0;
    public generation: unknown = null;
    public claimed: JobEnvelope | null = null;
    public refused: { id: string; toolName: string } | null = null;

    constructor(private readonly inner: MasterTransport) {}

    public async heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse> {
        const response = await this.inner.heartbeat(request);
        this.heartbeats += 1;
        this.generation = response.generation;
        return response;
    }

    public async claim(request: ClaimRequest): Promise<ClaimResponse> {
        if (this.claimed || this.refused) return { job: null };
        const response = await this.inner.claim(request);
        if (response.job && response.job.capability !== 'vone_executor_execute') {
            this.refused = { id: response.job.job_id, toolName: response.job.capability };
            throw new TransportError(
                redactSecrets(`smoke runner accepts only vone_executor_execute; job ${response.job.job_id} left unexecuted`),
                'protocol',
                false,
            );
        }
        if (response.job) this.claimed = response.job;
        return response;
    }

    public submitResult(submission: ResultSubmission): Promise<ResultAck> {
        return this.inner.submitResult(submission);
    }
}

export interface SmokeOptions {
    readonly env: NodeJS.ProcessEnv;
    /** Test seams only; the CLI passes none. */
    readonly deps?: WorkerDependencies;
    readonly waitMs?: number;
    readonly pollMs?: number;
    readonly out?: (line: string) => void;
}

export interface SmokeReport {
    readonly exitCode: number;
    readonly summary: Record<string, unknown>;
}

export async function runE2ESmoke(options: SmokeOptions): Promise<SmokeReport> {
    const started = Date.now();
    const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
    const secrets = [options.env.VONE_WORKER_TOKEN, options.env.VONE_CF_AI_TOKEN].filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0,
    );
    const emit = (exitCode: number, summary: Record<string, unknown>): SmokeReport => {
        const full = { event: 'vone.e2e.summary', ...summary, exit_code: exitCode, elapsed_ms: Date.now() - started };
        let line = JSON.stringify(full);
        for (const secret of secrets) line = line.split(secret).join('[REDACTED]');
        out(redactSecrets(line));
        return { exitCode, summary: full };
    };

    let config: WorkerConfig;
    let composed: ComposedWorker;
    let transport: SmokeTransport;
    try {
        config = loadWorkerConfig(options.env);
        transport = new SmokeTransport(
            options.deps?.transport ??
                new HttpMasterTransport({
                    baseUrl: config.masterUrl,
                    credential: config.credential,
                    timeoutMs: config.requestTimeoutMs,
                    fetchImpl: options.deps?.fetchImpl,
                }),
        );
        composed = createWorkerFromConfig(config, { ...options.deps, transport, log: () => {} });
    } catch (error) {
        if (error instanceof WorkerConfigError) {
            return emit(78, { verdict: 'FAIL_CLOSED', reason: 'CONFIG_REFUSED', missing_or_invalid: [...error.missingOrInvalid] });
        }
        throw error;
    }

    const base = {
        master_host: new URL(config.masterUrl).host,
        worker_id: config.workerId,
        worker_token: 'present',
        model_route: config.modelRoute ?? '(injected)',
        model: config.ollama?.model ?? null,
    };
    const waitMs = options.waitMs ?? readMs(options.env.VONE_E2E_WAIT_MS, 120_000);
    const pollMs = options.pollMs ?? config.pollIntervalMs;
    const sleep = options.deps?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const readLedger = (key: string) => new SandboxResultLedger(composed.workerSandbox).get(key);

    let last: TickOutcome = { kind: 'idle' };
    let executed: boolean | null = null;
    let replayed: boolean | null = null;
    for (;;) {
        last = await composed.worker.runOnce();
        if ('executed' in last) executed = last.executed;
        if (last.kind === 'completed') replayed = last.replayed;
        const tail = { ...base, heartbeats: transport.heartbeats, heartbeat_generation: transport.generation, last_outcome: last.kind };
        if (last.kind === 'auth_rejected') {
            return emit(77, { ...tail, verdict: 'FAIL_CLOSED', reason: 'AUTH_REJECTED', phase: last.phase });
        }
        if (transport.refused) {
            return emit(2, { ...tail, verdict: 'HOLD', reason: 'NON_EXECUTOR_JOB', job: transport.refused });
        }
        if (last.kind === 'protocol_error' || last.kind === 'claim_refused') {
            return emit(2, { ...tail, verdict: 'HOLD', reason: last.kind.toUpperCase(), error: 'error' in last ? last.error : last.reason });
        }
        const entry = transport.claimed ? readLedger(transport.claimed.idempotency_key) : undefined;
        if (entry && entry.state !== 'COMPUTED') break;
        if (Date.now() - started >= waitMs) {
            const reason = !transport.claimed ? (last.kind === 'master_unreachable' ? 'MASTER_UNREACHABLE' : 'NO_JOB') : 'RESULT_NOT_DELIVERED';
            return emit(2, { ...tail, verdict: 'HOLD', reason, job: summarizeJob(transport.claimed) });
        }
        await sleep(pollMs);
    }

    const job = transport.claimed!;
    const entry = readLedger(job.idempotency_key)!;
    const sessionId = typeof job.payload.session_id === 'string' ? job.payload.session_id : '';
    const checkpoint = sessionId ? new VOneSessionHydrationEngine(composed.workerSandbox, 'sessions').hydrate(sessionId, '') : null;
    const evaluation = evaluateSmokeEvidence({
        entry,
        checkpoint,
        readArtifact: (path) => {
            try {
                return composed.sandbox.readFile(path);
            } catch {
                return null;
            }
        },
    });
    const output = entry.result.output.kind === 'executor' ? (entry.result.output as ExecutorJobOutput) : null;
    return emit(evaluation.verdict === 'PASS' ? 0 : 2, {
        ...base,
        verdict: evaluation.verdict,
        reason: entry.state === 'REJECTED_BY_MASTER' ? 'RESULT_REJECTED_409' : evaluation.failed[0] ?? null,
        heartbeats: transport.heartbeats,
        heartbeat_generation: transport.generation,
        job: summarizeJob(job),
        executed_this_run: executed,
        replayed,
        master_ack: entry.state === 'SUBMITTED' ? 'accepted' : entry.state === 'REJECTED_BY_MASTER' ? 'rejected_409' : 'pending',
        status: entry.result.status,
        evidence_verdict: entry.result.evidence.verdict,
        output_sha256: entry.result.evidence.output_sha256,
        artifact_hashes: entry.result.evidence.artifact_hashes,
        checkpoint_revision: output?.local_checkpoint_revision ?? null,
        route_id: output?.route_id ?? null,
        checks: evaluation.checks,
    });
}

function summarizeJob(job: JobEnvelope | null): { id: string; toolName: string } | null {
    return job ? { id: job.job_id, toolName: job.capability } : null;
}

function readMs(raw: string | undefined, fallback: number): number {
    const value = Number(raw);
    return raw && Number.isInteger(value) && value > 0 ? value : fallback;
}

function sha256(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Same canonical form the worker hashes output with (vone_master_worker.ts), re-derived here to verify it. */
function stableStringify(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
            .filter((key) => record[key] !== undefined)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

if (require.main === module) {
    runE2ESmoke({ env: process.env })
        .then((report) => {
            process.exitCode = report.exitCode;
        })
        .catch((error) => {
            process.stderr.write(`${redactSecrets(error instanceof Error ? error.message : String(error))}\n`);
            process.exitCode = 1;
        });
}
