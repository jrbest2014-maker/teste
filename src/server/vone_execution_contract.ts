/**
 * VONE_EXECUTION_CONTRACT_R1 over the VONE_WORKER_IDENTITY_R1 worker wire -
 * V-ONE Master -> worker execution path
 * (heartbeat -> claim -> dispatch -> result).
 *
 * The WIRE section transcribes the Master's R1 worker API as specified by
 * the Master side:
 *   POST /api/worker/heartbeat  {workerId, version, statusPayload}
 *                            -> {ok:true, workerId, auth:"IDENTITY_R1", generation}
 *   POST /api/worker/claim      {workerId}
 *                            -> {ok:true, job:null}
 *                             | {ok:true, job:{id, toolName, args, createdAt}, auth:"IDENTITY_R1"}
 *   POST /api/worker/result     {jobId, workerId, result} | {jobId, workerId, error}
 *                            -> {ok:true, jobId, auth:"IDENTITY_R1"}
 *                             | HTTP 409 {ok:false, error:"job_not_owned_or_not_claimed"}
 * Auth is `Authorization: Bearer <VONE_WORKER_TOKEN>`. There is no lease, no
 * idempotency key, no contract header and no ack revision on this wire.
 *
 * The INTERNAL section is what VOneMasterWorker consumes. The adapters below
 * are the only place the two meet, and the R1 adapters never read an
 * internal-only field from the wire:
 *   - job_id / task_id / idempotency_key all come from the R1 job id, so a
 *     re-delivered job id replays its stored result instead of re-running;
 *   - capability comes from toolName and payload from args;
 *   - worker_id is the claimant, lease_id a local reference and
 *     lease_expires_at +Infinity - ownership is enforced by the Master
 *     (HTTP 409), not by a lease the wire does not have.
 * A response that does not prove IDENTITY_R1 (missing auth marker, a
 * heartbeat answered for another workerId) is an IdentityViolationError,
 * which transports surface as an auth failure: the worker stops.
 */

// ===========================================================================
// WIRE - VONE_WORKER_IDENTITY_R1
// ===========================================================================

export const EXECUTION_CONTRACT_VERSION = 'VONE_EXECUTION_CONTRACT_R1' as const;
export type ExecutionContractVersion = typeof EXECUTION_CONTRACT_VERSION;

export const WORKER_PROTOCOL = 'VONE_WORKER_IDENTITY_R1' as const;
export const WORKER_AUTH_MARKER = 'IDENTITY_R1' as const;
export const R1_NOT_OWNED_ERROR = 'job_not_owned_or_not_claimed' as const;

export const R1_HTTP_PATHS = Object.freeze({
    heartbeat: '/api/worker/heartbeat',
    claim: '/api/worker/claim',
    result: '/api/worker/result',
});

export interface R1HeartbeatBody {
    readonly workerId: string;
    readonly version: ExecutionContractVersion;
    readonly statusPayload: R1StatusPayload;
}

/** What this worker reports in statusPayload; the Master defines no schema for it. */
export interface R1StatusPayload {
    readonly status: 'IDLE' | 'BUSY';
    readonly capabilities: readonly WorkerCapability[];
    readonly pending_results: number;
    readonly gates: ContractGates;
}

export interface R1ClaimBody {
    readonly workerId: string;
}

export interface R1Job {
    readonly id: string;
    readonly toolName: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly createdAt?: unknown;
}

/** `result` sent for a DONE job. Everything a verifier needs: status, output, evidence, gates. */
export interface R1ResultPayload {
    readonly contract: ExecutionContractVersion;
    readonly idempotency_key: string;
    readonly task_id: string;
    readonly capability: string;
    readonly status: 'DONE';
    readonly output: JobOutput;
    readonly evidence: JobEvidence;
    readonly replayed: boolean;
    readonly gates: ContractGates;
}

export type R1ResultBody =
    | { readonly jobId: string; readonly workerId: string; readonly result: R1ResultPayload }
    | { readonly jobId: string; readonly workerId: string; readonly error: string };

// ===========================================================================
// INTERNAL - consumed by VOneMasterWorker, never read from the wire directly
// ===========================================================================

export type WorkerCapability = 'vone_executor_execute' | 'vone_inference_execute';
export const SUPPORTED_CAPABILITIES: readonly WorkerCapability[] = ['vone_executor_execute', 'vone_inference_execute'];

export function isSupportedCapability(value: unknown): value is WorkerCapability {
    return typeof value === 'string' && (SUPPORTED_CAPABILITIES as readonly string[]).includes(value);
}

/** Reported with every heartbeat and DONE result; the worker never accepts gate values from the Master. */
export interface ContractGates {
    readonly paid_blocked: 'INVIOLABLE';
    readonly unknown_cost: 'HOLD';
    readonly physical_output: 'LOCKED';
    readonly no_evidence_no_pass: true;
}

export const REQUIRED_GATES: ContractGates = Object.freeze({
    paid_blocked: 'INVIOLABLE',
    unknown_cost: 'HOLD',
    physical_output: 'LOCKED',
    no_evidence_no_pass: true,
});

export interface HeartbeatRequest {
    readonly contract: ExecutionContractVersion;
    readonly worker_id: string;
    readonly capabilities: readonly WorkerCapability[];
    readonly status: 'IDLE' | 'BUSY';
    readonly pending_results: number;
    readonly gates: ContractGates;
}

export interface HeartbeatResponse {
    readonly ok: true;
    readonly generation: unknown;
}

export interface ClaimRequest {
    readonly contract: ExecutionContractVersion;
    readonly worker_id: string;
    readonly capabilities: readonly WorkerCapability[];
}

/** Args for `vone_executor_execute` -> VOneExecutor.execute(). */
export interface ExecutorJobPayload {
    readonly session_id: string;
    readonly objective: string;
}

/** Args for `vone_inference_execute` -> one ModelRouter.dispatch(). */
export interface InferenceJobPayload {
    readonly prompt: string;
    readonly max_tokens?: number;
    readonly requires_physical_output?: boolean;
}

/**
 * A claimed job as the worker sees it. `capability` stays a plain string so
 * an unknown toolName reaches the worker and is REJECTED explicitly. For R1
 * see the module header: worker_id is the claimant, lease_id a local
 * reference that is never sent, lease_expires_at +Infinity.
 */
export interface JobEnvelope {
    readonly job_id: string;
    readonly task_id: string;
    readonly idempotency_key: string;
    readonly capability: string;
    readonly worker_id: string;
    readonly lease_id: string;
    /** epoch milliseconds; +Infinity when the wire has no lease */
    readonly lease_expires_at: number;
    readonly payload: Readonly<Record<string, unknown>>;
}

export interface ClaimResponse {
    readonly job: JobEnvelope | null;
}

/** Outcome of a job from the worker's point of view. */
export type JobResultStatus = 'DONE' | 'BLOCKED' | 'FAILED' | 'INCOMPLETE' | 'REJECTED';

/**
 * NO_EVIDENCE_NO_PASS verdict. PASS requires status DONE *and* evidence:
 * for vone_executor_execute at least one artifact with a sha256; for
 * vone_inference_execute a non-empty text with its sha256 and the route it
 * ran on. DONE without that evidence is HOLD, never PASS.
 */
export type JobVerdict = 'PASS' | 'HOLD' | 'BLOCKED' | 'FAIL';

export interface ExecutorJobOutput {
    readonly kind: 'executor';
    readonly agent_status: string;
    readonly summary: string | null;
    readonly step_count: number;
    readonly local_checkpoint_revision: number;
    readonly artifacts: ReadonlyArray<{ readonly path: string; readonly sha256: string }>;
    readonly route_id: string | null;
    readonly model: string | null;
    readonly run_id: string;
    readonly error_class: string;
    readonly gate_decisions: ReadonlyArray<{ readonly category: string; readonly reason: string }>;
}

export interface InferenceJobOutput {
    readonly kind: 'inference';
    readonly text: string;
    readonly route_id: string;
    readonly model: string;
    readonly neurons_used: number;
}

export interface BlockedJobOutput {
    readonly kind: 'blocked';
    /** RoutingBlockedError.category, passed through verbatim - never re-derived here. */
    readonly category: string;
    readonly reason: string;
}

export interface ErrorJobOutput {
    readonly kind: 'error';
    readonly error_code: 'UNSUPPORTED_CAPABILITY' | 'INVALID_PAYLOAD' | 'EXECUTION_ERROR';
    /** Already passed through redactSecrets(). */
    readonly message: string;
}

export type JobOutput = ExecutorJobOutput | InferenceJobOutput | BlockedJobOutput | ErrorJobOutput;

export interface JobEvidence {
    readonly verdict: JobVerdict;
    /** Why the verdict is not PASS (e.g. NO_EVIDENCE); null on PASS. */
    readonly verdict_reason: string | null;
    /** sha256 of the canonical JSON of `output`. */
    readonly output_sha256: string;
    readonly artifact_hashes: readonly string[];
    readonly completed_at: number;
}

/** Computed exactly once per idempotency_key and replayed verbatim on any re-delivery. */
export interface ComputedJobResult {
    readonly idempotency_key: string;
    readonly task_id: string;
    readonly capability: string;
    readonly status: JobResultStatus;
    readonly output: JobOutput;
    readonly evidence: JobEvidence;
}

/** What the worker hands its transport. lease_id is local bookkeeping and never sent on R1. */
export interface ResultSubmission extends ComputedJobResult {
    readonly contract: ExecutionContractVersion;
    readonly worker_id: string;
    readonly job_id: string;
    readonly lease_id: string;
    readonly replayed: boolean;
    readonly gates: ContractGates;
}

/** The R1 wire has exactly one rejection: HTTP 409 job_not_owned_or_not_claimed. */
export type ResultRejectionReason = 'JOB_NOT_OWNED_OR_NOT_CLAIMED';

/**
 * Derived from the R1 response (ok:true -> accepted, 409 -> rejected). The
 * optional fields are read by the worker but R1 carries neither, so the R1
 * adapter never sets them.
 */
export interface ResultAck {
    readonly accepted: boolean;
    readonly reason?: ResultRejectionReason;
    readonly duplicate?: boolean;
    readonly checkpoint_revision?: number;
}

/**
 * Everything the worker needs from the Master. Authentication lives entirely
 * inside the implementation (the worker never sees the token).
 */
export interface MasterTransport {
    heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse>;
    claim(request: ClaimRequest): Promise<ClaimResponse>;
    submitResult(submission: ResultSubmission): Promise<ResultAck>;
}

export type TransportErrorKind = 'network' | 'timeout' | 'auth' | 'http' | 'protocol';

/**
 * Raised by a MasterTransport. `retryable` is true only for conditions a
 * reconnect can fix (network, timeout, 5xx). Messages must never contain
 * credentials - implementations redact before constructing this.
 */
export class TransportError extends Error {
    constructor(
        message: string,
        public readonly kind: TransportErrorKind,
        public readonly retryable: boolean,
        public readonly httpStatus?: number,
    ) {
        super(`[MASTER TRANSPORT ${kind.toUpperCase()}]: ${message}`);
        this.name = 'TransportError';
    }
}

export class ContractViolationError extends Error {
    constructor(message: string) {
        super(`[CONTRACT VIOLATION]: ${message}`);
        this.name = 'ContractViolationError';
    }
}

/** A Master response that does not prove IDENTITY_R1 for this worker. Transports map it to an auth failure. */
export class IdentityViolationError extends ContractViolationError {
    constructor(message: string) {
        super(`identity: ${message}`);
        this.name = 'IdentityViolationError';
    }
}

/** Shared by every transport so the in-process test transport classifies exactly like HTTP. */
export function contractErrorToTransportError(error: unknown, scrub: (message: string) => string = (m) => m): unknown {
    if (error instanceof IdentityViolationError) return new TransportError(scrub(error.message), 'auth', false);
    if (error instanceof ContractViolationError) return new TransportError(scrub(error.message), 'protocol', false);
    return error;
}

// ===========================================================================
// ADAPTERS - internal <-> R1 wire
// ===========================================================================

function asRecord(value: unknown, what: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ContractViolationError(`${what} must be an object`);
    }
    return value as Record<string, unknown>;
}

function nonEmptyString(record: Record<string, unknown>, key: string, what: string): string {
    const value = record[key];
    if (typeof value !== 'string' || value.length === 0) {
        throw new ContractViolationError(`${what}.${key} must be a non-empty string`);
    }
    return value;
}

function requireOk(record: Record<string, unknown>, what: string): void {
    if (record.ok !== true) {
        const detail = typeof record.error === 'string' ? `: ${record.error.slice(0, 120)}` : '';
        throw new ContractViolationError(`${what}.ok is not true${detail}`);
    }
}

function requireAuthMarker(record: Record<string, unknown>, what: string): void {
    if (record.auth !== WORKER_AUTH_MARKER) {
        throw new IdentityViolationError(`${what}.auth must be ${WORKER_AUTH_MARKER}`);
    }
}

export function heartbeatToWire(request: HeartbeatRequest): R1HeartbeatBody {
    return {
        workerId: request.worker_id,
        version: request.contract,
        statusPayload: {
            status: request.status,
            capabilities: request.capabilities,
            pending_results: request.pending_results,
            gates: request.gates,
        },
    };
}

export function parseR1HeartbeatResponse(value: unknown, workerId: string): HeartbeatResponse {
    const record = asRecord(value, 'heartbeat response');
    requireOk(record, 'heartbeat response');
    requireAuthMarker(record, 'heartbeat response');
    if (record.workerId !== workerId) {
        throw new IdentityViolationError('heartbeat response is for a different workerId');
    }
    return { ok: true, generation: record.generation ?? null };
}

export function claimToWire(request: ClaimRequest): R1ClaimBody {
    return { workerId: request.worker_id };
}

export function parseR1Job(value: unknown): R1Job {
    const record = asRecord(value, 'job');
    const args = record.args === undefined || record.args === null ? {} : asRecord(record.args, 'job.args');
    return {
        id: nonEmptyString(record, 'id', 'job'),
        toolName: nonEmptyString(record, 'toolName', 'job'),
        args: { ...args },
        createdAt: record.createdAt,
    };
}

/** `workerId` is who claimed: on R1 the Master assigns the job to the claimant. */
export function parseR1ClaimResponse(value: unknown, workerId: string): ClaimResponse {
    const record = asRecord(value, 'claim response');
    requireOk(record, 'claim response');
    if (record.job === null || record.job === undefined) return { job: null };
    requireAuthMarker(record, 'claim response');
    const job = parseR1Job(record.job);
    return {
        job: {
            job_id: job.id,
            task_id: job.id,
            idempotency_key: job.id,
            capability: job.toolName,
            worker_id: workerId,
            lease_id: `r1:${job.id}`,
            lease_expires_at: Number.POSITIVE_INFINITY,
            payload: job.args,
        },
    };
}

const MAX_ERROR_TEXT = 1000;

/**
 * DONE is sent as `result` with the full evidence (its verdict may still be
 * HOLD under NO_EVIDENCE_NO_PASS). Every other status is sent as `error`:
 * one line with the status, the verdict, what stopped it and the output
 * hash. Error text is already redacted by the worker; the transport scrubs
 * it again before it leaves the process.
 */
export function resultToWire(submission: ResultSubmission): R1ResultBody {
    const base = { jobId: submission.job_id, workerId: submission.worker_id };
    if (submission.status === 'DONE') {
        return {
            ...base,
            result: {
                contract: submission.contract,
                idempotency_key: submission.idempotency_key,
                task_id: submission.task_id,
                capability: submission.capability,
                status: 'DONE',
                output: submission.output,
                evidence: submission.evidence,
                replayed: submission.replayed,
                gates: submission.gates,
            },
        };
    }
    const { evidence } = submission;
    const reason = evidence.verdict_reason ? ` (${evidence.verdict_reason})` : '';
    const text = `${submission.status} verdict=${evidence.verdict}${reason}: ${describeOutput(submission.output)} [output_sha256=${evidence.output_sha256}]`;
    return { ...base, error: text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT)}...` : text };
}

function describeOutput(output: JobOutput): string {
    switch (output.kind) {
        case 'error':
            return `${output.error_code}: ${output.message}`;
        case 'blocked':
            return `${output.category}: ${output.reason}`;
        case 'executor': {
            const gates = output.gate_decisions.map((gate) => gate.category).join(',');
            return `agent_status=${output.agent_status} error_class=${output.error_class}${gates ? ` gates=${gates}` : ''}`;
        }
        case 'inference':
            return `inference on ${output.route_id}`;
    }
}

export function parseR1ResultResponse(httpStatus: number, value: unknown, jobId: string): ResultAck {
    const record = asRecord(value, 'result response');
    if (httpStatus === 409) {
        if (record.ok === false && record.error === R1_NOT_OWNED_ERROR) {
            return { accepted: false, reason: 'JOB_NOT_OWNED_OR_NOT_CLAIMED' };
        }
        throw new ContractViolationError(`HTTP 409 without ${R1_NOT_OWNED_ERROR}`);
    }
    requireOk(record, 'result response');
    requireAuthMarker(record, 'result response');
    if (record.jobId !== jobId) {
        throw new ContractViolationError('result response.jobId does not match the submitted job');
    }
    return { accepted: true };
}

// ===========================================================================
// JOB ARGS - validated by the worker before anything runs
// ===========================================================================

export function parseExecutorPayload(payload: Readonly<Record<string, unknown>>): ExecutorJobPayload {
    const record = payload as Record<string, unknown>;
    return {
        session_id: nonEmptyString(record, 'session_id', 'payload'),
        objective: nonEmptyString(record, 'objective', 'payload'),
    };
}

export function parseInferencePayload(payload: Readonly<Record<string, unknown>>): InferenceJobPayload {
    const record = payload as Record<string, unknown>;
    const prompt = nonEmptyString(record, 'prompt', 'payload');
    const maxTokens = record.max_tokens;
    if (maxTokens !== undefined && (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens <= 0)) {
        throw new ContractViolationError('payload.max_tokens must be a positive integer');
    }
    const physical = record.requires_physical_output;
    if (physical !== undefined && typeof physical !== 'boolean') {
        throw new ContractViolationError('payload.requires_physical_output must be a boolean');
    }
    return { prompt, max_tokens: maxTokens as number | undefined, requires_physical_output: physical as boolean | undefined };
}
