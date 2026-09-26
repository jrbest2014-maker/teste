import { createHash } from 'node:crypto';
import { redactSecrets } from '../core/vone_secret_redaction';
import type { VOneVFSSandbox } from '../core/vone_vfs_sandbox';
import {
    ContractViolationError,
    EXECUTION_CONTRACT_VERSION,
    REQUIRED_GATES,
    SUPPORTED_CAPABILITIES,
    TransportError,
    isSupportedCapability,
    parseExecutorPayload,
    parseInferencePayload,
    type ComputedJobResult,
    type JobEnvelope,
    type JobOutput,
    type JobResultStatus,
    type JobVerdict,
    type MasterTransport,
    type ResultAck,
    type ResultSubmission,
} from './vone_execution_contract';
import type { ExecutorRequest, ExecutorResult } from './vone_executor';
import {
    RoutingBlockedError,
    type InferenceRequest,
    type InferenceResult,
    type RoutingGates,
} from './vone_model_router';

/** Satisfied structurally by VOneExecutor. */
export interface ExecutorPort {
    execute(request: ExecutorRequest): Promise<ExecutorResult>;
}

/** Satisfied structurally by ModelRouter (gated dispatch). */
export interface InferencePort {
    dispatch(request: InferenceRequest): Promise<InferenceResult>;
}

// ---------------------------------------------------------------------------
// Idempotency / evidence ledger
// ---------------------------------------------------------------------------

export type LedgerEntryState = 'COMPUTED' | 'SUBMITTED' | 'REJECTED_BY_MASTER';

export interface LedgerEntry {
    readonly result: ComputedJobResult;
    state: LedgerEntryState;
    /** Identifiers of the claim the result was last submitted under. */
    job_id: string;
    lease_id: string;
    submit_attempts: number;
    master_checkpoint_revision: number | null;
    rejection_reason: string | null;
}

/**
 * Keyed by idempotency_key. An entry is written BEFORE the first submit
 * attempt, so an interruption between "computed" and "acknowledged" can
 * never cause a re-execution - only a re-submission.
 */
export interface WorkerResultLedger {
    get(idempotencyKey: string): LedgerEntry | undefined;
    put(entry: LedgerEntry): void;
    pending(): LedgerEntry[];
}

export class InMemoryResultLedger implements WorkerResultLedger {
    protected readonly entries = new Map<string, LedgerEntry>();

    public get(idempotencyKey: string): LedgerEntry | undefined {
        return this.entries.get(idempotencyKey);
    }

    public put(entry: LedgerEntry): void {
        this.entries.set(entry.result.idempotency_key, entry);
    }

    public pending(): LedgerEntry[] {
        return [...this.entries.values()].filter((entry) => entry.state === 'COMPUTED');
    }
}

/**
 * Ledger persisted inside the VOneVFSSandbox root, so a worker process that
 * is killed and restarted keeps its idempotency guarantees and its evidence.
 */
export class SandboxResultLedger extends InMemoryResultLedger {
    constructor(
        private readonly sandbox: VOneVFSSandbox,
        private readonly fileName: string = '.vone_worker_ledger.json',
    ) {
        super();
        const raw = sandbox.readFile(fileName);
        if (raw) {
            const parsed = JSON.parse(raw) as { entries?: LedgerEntry[] };
            for (const entry of parsed.entries ?? []) {
                this.entries.set(entry.result.idempotency_key, entry);
            }
        }
    }

    public put(entry: LedgerEntry): void {
        super.put(entry);
        this.sandbox.writeFile(
            this.fileName,
            JSON.stringify({ contract: EXECUTION_CONTRACT_VERSION, entries: [...this.entries.values()] }, null, 2),
        );
    }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export type TickOutcome =
    | { kind: 'idle' }
    | { kind: 'busy' }
    | {
          kind: 'completed';
          job_id: string;
          idempotency_key: string;
          status: JobResultStatus;
          verdict: JobVerdict;
          executed: boolean;
          replayed: boolean;
          duplicate: boolean;
      }
    | { kind: 'result_rejected'; job_id: string; idempotency_key: string; reason: string; executed: boolean }
    | { kind: 'submit_deferred'; job_id: string; idempotency_key: string; executed: boolean; error: string }
    | { kind: 'claim_refused'; job_id: string; reason: 'FOREIGN_OWNER' | 'LEASE_EXPIRED' }
    | { kind: 'master_unreachable'; phase: Phase; error: string }
    | { kind: 'auth_rejected'; phase: Phase; error: string }
    | { kind: 'protocol_error'; phase: Phase; error: string };

export interface WorkerLogEvent {
    readonly event: string;
    readonly [field: string]: unknown;
}

export interface SubmitRetryPolicy {
    readonly maxAttempts: number;
    readonly baseDelayMs: number;
    readonly maxDelayMs: number;
}

export interface VOneMasterWorkerOptions {
    readonly workerId: string;
    readonly transport: MasterTransport;
    readonly executor: ExecutorPort;
    readonly inference: InferencePort;
    /** The same gates object the ModelRouter was built with; must be the strict defaults. */
    readonly gates: RoutingGates;
    readonly ledger?: WorkerResultLedger;
    readonly submitRetry?: SubmitRetryPolicy;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly now?: () => number;
    readonly log?: (event: WorkerLogEvent) => void;
}

export interface RunLoopOptions {
    readonly signal?: AbortSignal;
    readonly idleDelayMs?: number;
    readonly maxBackoffMs?: number;
    readonly maxTicks?: number;
}

const DEFAULT_RETRY: SubmitRetryPolicy = { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 5000 };
const MAX_ERROR_MESSAGE = 300;

type Phase = 'heartbeat' | 'flush' | 'claim' | 'submit';

/**
 * Executor-side worker for VONE_EXECUTION_CONTRACT_R1:
 *
 *   heartbeat -> (flush pending results) -> claim -> dispatch -> result
 *
 * - `vone_executor_execute`  -> VOneExecutor.execute()  (full agent loop)
 * - `vone_inference_execute` -> one ModelRouter.dispatch() (gated, no loop)
 * - anything else            -> REJECTED / UNSUPPORTED_CAPABILITY, nothing runs
 *
 * Gates are never re-implemented here: a RoutingBlockedError from the router
 * becomes a BLOCKED result carrying its `category` verbatim. The worker
 * refuses to even construct unless it is handed the strict gate set
 * (PAID_BLOCKED=INVIOLABLE, UNKNOWN_COST=HOLD, PHYSICAL_OUTPUT=LOCKED), and
 * nothing in a job envelope can change those gates.
 *
 * Ownership: a claim whose envelope names a different worker_id, or whose
 * lease already expired, is refused without executing. A result the Master
 * rejects (e.g. WRONG_WORKER after a lease was reassigned) is recorded and
 * dropped - never re-executed.
 *
 * Idempotency: results are stored by idempotency_key before submission; a
 * re-delivered key (Master retry, reconnection, process restart with a
 * persisted ledger) resubmits the stored result with the new lease
 * identifiers instead of executing again.
 *
 * NO_EVIDENCE_NO_PASS: see JobVerdict in the contract module.
 */
export class VOneMasterWorker {
    private readonly ledger: WorkerResultLedger;
    private readonly retry: SubmitRetryPolicy;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly now: () => number;
    private readonly log: (event: WorkerLogEvent) => void;
    private busy = false;

    constructor(private readonly options: VOneMasterWorkerOptions) {
        if (!options.workerId) {
            throw new Error('[WORKER]: workerId is required.');
        }
        assertStrictGates(options.gates);
        this.ledger = options.ledger ?? new InMemoryResultLedger();
        this.retry = options.submitRetry ?? DEFAULT_RETRY;
        this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.now = options.now ?? Date.now;
        this.log = options.log ?? ((event) => console.log(JSON.stringify(event)));
    }

    public get workerId(): string {
        return this.options.workerId;
    }

    /** One full heartbeat -> flush -> claim -> dispatch -> result cycle. */
    public async runOnce(): Promise<TickOutcome> {
        if (this.busy) return { kind: 'busy' };
        this.busy = true;
        try {
            return await this.tick();
        } finally {
            this.busy = false;
        }
    }

    /**
     * Polls until aborted. Backs off exponentially while the Master is
     * unreachable (reconnection), stops for good on an auth rejection
     * (fail-closed) and returns the list of tick outcomes.
     */
    public async run(options: RunLoopOptions = {}): Promise<TickOutcome[]> {
        const idleDelayMs = options.idleDelayMs ?? 5000;
        const maxBackoffMs = options.maxBackoffMs ?? 60000;
        const outcomes: TickOutcome[] = [];
        let backoffMs = idleDelayMs;

        while (!options.signal?.aborted && (options.maxTicks === undefined || outcomes.length < options.maxTicks)) {
            const outcome = await this.runOnce();
            outcomes.push(outcome);

            if (outcome.kind === 'auth_rejected') {
                this.log({ event: 'worker.stopped', reason: 'auth_rejected' });
                break;
            }
            if (outcome.kind === 'master_unreachable' || outcome.kind === 'submit_deferred' || outcome.kind === 'protocol_error') {
                await this.sleep(backoffMs);
                backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
                continue;
            }
            backoffMs = idleDelayMs;
            if (outcome.kind === 'idle') {
                await this.sleep(idleDelayMs);
            }
        }
        return outcomes;
    }

    private async tick(): Promise<TickOutcome> {
        // 1. heartbeat
        try {
            await this.options.transport.heartbeat({
                contract: EXECUTION_CONTRACT_VERSION,
                worker_id: this.workerId,
                capabilities: SUPPORTED_CAPABILITIES,
                status: 'IDLE',
                pending_results: this.ledger.pending().length,
                gates: REQUIRED_GATES,
            });
        } catch (error) {
            return this.transportFailure('heartbeat', error);
        }

        // 2. deliver anything computed but not yet acknowledged (reconnection)
        for (const entry of this.ledger.pending()) {
            const outcome = await this.submit(entry, entry.job_id, entry.lease_id, true, false);
            if (outcome.kind === 'submit_deferred') {
                return { kind: 'master_unreachable', phase: 'flush', error: outcome.error };
            }
            if (outcome.kind === 'auth_rejected' || outcome.kind === 'protocol_error') {
                return { ...outcome, phase: 'flush' };
            }
        }

        // 3. claim
        let job: JobEnvelope | null;
        try {
            job = (
                await this.options.transport.claim({
                    contract: EXECUTION_CONTRACT_VERSION,
                    worker_id: this.workerId,
                    capabilities: SUPPORTED_CAPABILITIES,
                })
            ).job;
        } catch (error) {
            return this.transportFailure('claim', error);
        }

        if (!job) {
            this.log({ event: 'claim.empty', worker_id: this.workerId });
            return { kind: 'idle' };
        }

        // 4. ownership + lease checks - refuse before executing anything
        if (job.worker_id !== this.workerId) {
            this.log({ event: 'claim.refused', job_id: job.job_id, reason: 'FOREIGN_OWNER' });
            return { kind: 'claim_refused', job_id: job.job_id, reason: 'FOREIGN_OWNER' };
        }
        if (job.lease_expires_at <= this.now()) {
            this.log({ event: 'claim.refused', job_id: job.job_id, reason: 'LEASE_EXPIRED' });
            return { kind: 'claim_refused', job_id: job.job_id, reason: 'LEASE_EXPIRED' };
        }

        // 5. idempotent replay
        const existing = this.ledger.get(job.idempotency_key);
        if (existing) {
            this.log({ event: 'job.replay', job_id: job.job_id, idempotency_key: job.idempotency_key });
            return this.submit(existing, job.job_id, job.lease_id, true, false);
        }

        // 6. dispatch (exactly once per idempotency_key)
        this.log({ event: 'job.dispatch', job_id: job.job_id, capability: job.capability });
        const result = await this.dispatch(job);
        const entry: LedgerEntry = {
            result,
            state: 'COMPUTED',
            job_id: job.job_id,
            lease_id: job.lease_id,
            submit_attempts: 0,
            master_checkpoint_revision: null,
            rejection_reason: null,
        };
        this.ledger.put(entry);

        // 7. result
        return this.submit(entry, job.job_id, job.lease_id, false, true);
    }

    private async dispatch(job: JobEnvelope): Promise<ComputedJobResult> {
        const base = { idempotency_key: job.idempotency_key, task_id: job.task_id, capability: job.capability };

        if (!isSupportedCapability(job.capability)) {
            return finalize(base, 'REJECTED', 'FAIL', 'UNSUPPORTED_CAPABILITY', {
                kind: 'error',
                error_code: 'UNSUPPORTED_CAPABILITY',
                message: clip(`capability "${redactSecrets(job.capability)}" is not supported by this worker`),
            }, this.now());
        }

        try {
            if (job.capability === 'vone_executor_execute') {
                return await this.runExecutor(job, base);
            }
            return await this.runInference(job, base);
        } catch (error) {
            if (error instanceof ContractViolationError) {
                return finalize(base, 'REJECTED', 'FAIL', 'INVALID_PAYLOAD', {
                    kind: 'error',
                    error_code: 'INVALID_PAYLOAD',
                    message: clip(redactSecrets(error.message)),
                }, this.now());
            }
            const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
            return finalize(base, 'FAILED', 'FAIL', 'EXECUTION_ERROR', {
                kind: 'error',
                error_code: 'EXECUTION_ERROR',
                message: clip(redactSecrets(message)),
            }, this.now());
        }
    }

    private async runExecutor(job: JobEnvelope, base: ResultBase): Promise<ComputedJobResult> {
        const payload = parseExecutorPayload(job.payload);
        const { state, telemetry } = await this.options.executor.execute({
            sessionId: payload.session_id,
            objective: payload.objective,
            taskId: job.task_id,
        });

        const last = state.stepsHistory[state.stepsHistory.length - 1];
        const summary = last?.decision?.action === 'finish' ? redactSecrets(last.decision.summary) : null;
        const output: JobOutput = {
            kind: 'executor',
            agent_status: state.status,
            summary,
            step_count: telemetry.stepCount,
            local_checkpoint_revision: state.checkpointRevision,
            artifacts: state.artifacts.map((artifact) => ({ path: redactSecrets(artifact.path), sha256: artifact.sha256 })),
            route_id: telemetry.routeId,
            model: telemetry.model,
            run_id: telemetry.runId,
            error_class: telemetry.errorClass,
            gate_decisions: telemetry.gateDecisions.map((gate) => ({ category: gate.category, reason: gate.reason })),
        };

        switch (state.status) {
            case 'DONE':
                return state.artifacts.length > 0
                    ? finalize(base, 'DONE', 'PASS', null, output, this.now())
                    : finalize(base, 'DONE', 'HOLD', 'NO_EVIDENCE', output, this.now());
            case 'BLOCKED':
                return finalize(base, 'BLOCKED', 'BLOCKED', telemetry.gateDecisions[0]?.category ?? 'BLOCKED', output, this.now());
            case 'INCOMPLETE':
                return finalize(base, 'INCOMPLETE', 'HOLD', 'MAX_STEPS_EXCEEDED', output, this.now());
            default:
                return finalize(base, 'FAILED', 'FAIL', telemetry.errorClass, output, this.now());
        }
    }

    private async runInference(job: JobEnvelope, base: ResultBase): Promise<ComputedJobResult> {
        const payload = parseInferencePayload(job.payload);
        let result: InferenceResult;
        try {
            result = await this.options.inference.dispatch({
                prompt: payload.prompt,
                maxTokens: payload.max_tokens,
                requiresPhysicalOutput: payload.requires_physical_output,
            });
        } catch (error) {
            if (error instanceof RoutingBlockedError) {
                return finalize(base, 'BLOCKED', 'BLOCKED', error.category, {
                    kind: 'blocked',
                    category: error.category,
                    reason: error.reason,
                }, this.now());
            }
            throw error;
        }

        const text = redactSecrets(result.text);
        const output: JobOutput = {
            kind: 'inference',
            text,
            route_id: result.routeId,
            model: result.model,
            neurons_used: result.neuronsUsed,
        };
        return text.trim().length > 0 && result.routeId
            ? finalize(base, 'DONE', 'PASS', null, output, this.now())
            : finalize(base, 'DONE', 'HOLD', 'NO_EVIDENCE', output, this.now());
    }

    private async submit(
        entry: LedgerEntry,
        jobId: string,
        leaseId: string,
        replayed: boolean,
        executed: boolean,
    ): Promise<TickOutcome> {
        const submission: ResultSubmission = {
            ...entry.result,
            contract: EXECUTION_CONTRACT_VERSION,
            worker_id: this.workerId,
            job_id: jobId,
            lease_id: leaseId,
            replayed,
            gates: REQUIRED_GATES,
        };
        entry.job_id = jobId;
        entry.lease_id = leaseId;

        let lastError = '';
        for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt += 1) {
            entry.submit_attempts += 1;
            let ack: ResultAck;
            try {
                ack = await this.options.transport.submitResult(submission);
            } catch (error) {
                if (error instanceof TransportError && error.retryable) {
                    lastError = safeMessage(error);
                    this.ledger.put(entry);
                    this.log({ event: 'result.submit_retry', job_id: jobId, attempt, error: lastError });
                    if (attempt < this.retry.maxAttempts) {
                        await this.sleep(Math.min(this.retry.baseDelayMs * 2 ** (attempt - 1), this.retry.maxDelayMs));
                    }
                    continue;
                }
                this.ledger.put(entry);
                const failure = this.transportFailure('submit', error);
                return failure.kind === 'master_unreachable'
                    ? { kind: 'submit_deferred', job_id: jobId, idempotency_key: entry.result.idempotency_key, executed, error: failure.error }
                    : failure;
            }

            if (ack.accepted) {
                entry.state = 'SUBMITTED';
                entry.master_checkpoint_revision = ack.checkpoint_revision ?? null;
                entry.rejection_reason = null;
                this.ledger.put(entry);
                this.log({
                    event: 'result.accepted',
                    job_id: jobId,
                    status: entry.result.status,
                    verdict: entry.result.evidence.verdict,
                    replayed,
                    duplicate: ack.duplicate === true,
                });
                return {
                    kind: 'completed',
                    job_id: jobId,
                    idempotency_key: entry.result.idempotency_key,
                    status: entry.result.status,
                    verdict: entry.result.evidence.verdict,
                    executed,
                    replayed,
                    duplicate: ack.duplicate === true,
                };
            }

            // Ownership / lease rejection: record it, never re-execute, never retry.
            entry.state = 'REJECTED_BY_MASTER';
            entry.rejection_reason = ack.reason ?? 'UNSPECIFIED';
            this.ledger.put(entry);
            this.log({ event: 'result.rejected', job_id: jobId, reason: entry.rejection_reason });
            return {
                kind: 'result_rejected',
                job_id: jobId,
                idempotency_key: entry.result.idempotency_key,
                reason: entry.rejection_reason,
                executed,
            };
        }

        return {
            kind: 'submit_deferred',
            job_id: jobId,
            idempotency_key: entry.result.idempotency_key,
            executed,
            error: lastError,
        };
    }

    private transportFailure(phase: Phase, error: unknown): TickOutcome {
        const message = safeMessage(error);
        this.log({ event: 'transport.error', phase, error: message });
        if (error instanceof TransportError) {
            if (error.kind === 'auth') return { kind: 'auth_rejected', phase, error: message };
            if (error.retryable) return { kind: 'master_unreachable', phase, error: message };
            return { kind: 'protocol_error', phase, error: message };
        }
        return { kind: 'protocol_error', phase, error: message };
    }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type ResultBase = Pick<ComputedJobResult, 'idempotency_key' | 'task_id' | 'capability'>;

function finalize(
    base: ResultBase,
    status: JobResultStatus,
    verdict: JobVerdict,
    verdictReason: string | null,
    output: JobOutput,
    completedAt: number,
): ComputedJobResult {
    const artifactHashes = output.kind === 'executor' ? output.artifacts.map((artifact) => artifact.sha256) : [];
    return {
        ...base,
        status,
        output,
        evidence: {
            verdict,
            verdict_reason: verdictReason,
            output_sha256: createHash('sha256').update(stableStringify(output), 'utf8').digest('hex'),
            artifact_hashes: artifactHashes,
            completed_at: completedAt,
        },
    };
}

export function assertStrictGates(gates: RoutingGates | undefined): void {
    if (
        !gates ||
        gates.paidBlocked !== 'INVIOLABLE' ||
        gates.unknownCost !== 'HOLD' ||
        gates.physicalOutput !== 'LOCKED'
    ) {
        throw new Error(
            '[WORKER]: refusing to start - gates must be PAID_BLOCKED=INVIOLABLE, UNKNOWN_COST=HOLD, PHYSICAL_OUTPUT=LOCKED.',
        );
    }
}

function safeMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return clip(redactSecrets(message));
}

function clip(text: string): string {
    return text.length > MAX_ERROR_MESSAGE ? `${text.slice(0, MAX_ERROR_MESSAGE)}…` : text;
}

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
