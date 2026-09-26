/**
 * VONE_EXECUTION_CONTRACT_R1 - executor-side types for the
 * V-ONE Master -> worker execution path
 * (heartbeat -> claim -> dispatch -> result -> checkpoint/evidence).
 *
 * ============================ READ THIS FIRST ============================
 * THE WIRE FORMAT IN THIS FILE IS INFERRED AND NOT VERIFIED against the real
 * V-ONE Master. Exactly two things were observed:
 *
 *   1. One real response of the Master's `vone_delegate_execute` tool - see
 *      ObservedDelegationResponse below, which is transcribed as observed.
 *   2. That tool's description: "Uses the native VOneExecutor contract when
 *      an owned worker advertises it".
 *
 * The heartbeat / claim / result messages, their field names, the HTTP
 * paths and the ack/rejection codes are a PROPOSAL written for the local
 * mock Master only. Every proposed type is tagged `@proposal`. Where a
 * proposed field reuses a name that appears in the observed response
 * (task_id, idempotency_key, checkpoint_revision, gates.paid_blocked,
 * gates.unknown_cost) the name was reused on purpose, but its semantics in
 * a heartbeat/claim/result exchange are still unverified.
 *
 * Swapping in the real wire format should only touch this module and the
 * MasterTransport implementation (vone_http_master_transport.ts): the worker
 * (vone_master_worker.ts) talks to the Master solely through the
 * MasterTransport interface declared here.
 * ==========================================================================
 */

export const EXECUTION_CONTRACT_VERSION = 'VONE_EXECUTION_CONTRACT_R1' as const;
export type ExecutionContractVersion = typeof EXECUTION_CONTRACT_VERSION;

// ---------------------------------------------------------------------------
// OBSERVED (transcribed from one real vone_delegate_execute response)
// ---------------------------------------------------------------------------

/** Transcribed from one real `vone_delegate_execute` response - OBSERVED, not proposed. */
export interface ObservedDelegationResponse {
    readonly ok: boolean;
    readonly mode: 'VONE_EXECUTIVE_DELEGATION_R1';
    readonly execution_contract: ExecutionContractVersion;
    readonly supervisor_role: 'LIGHTWEIGHT';
    readonly route: 'CLOUDFLARE_ZERO_COST_GATED';
    readonly task_id: string;
    readonly idempotency_key: string;
    readonly checkpoint_revision: number;
    readonly execution: {
        readonly text: string;
        readonly model: string;
        readonly profile: unknown;
        readonly backend: unknown;
        readonly cloud: unknown;
        readonly desktop_runtime: unknown;
        readonly budget: {
            readonly day: unknown;
            readonly hard_cap_neurons: number;
            readonly reserved_neurons: number;
            readonly spent_neurons: number;
            readonly remaining_neurons: number;
            readonly calls: number;
            readonly last_model: string;
            readonly reset_at: unknown;
        };
    };
    readonly learning_id: unknown;
    readonly gates: { readonly paid_blocked: unknown; readonly unknown_cost: unknown };
}

// ---------------------------------------------------------------------------
// PROPOSAL - everything below is inferred for the local mock Master.
// ---------------------------------------------------------------------------

/** @proposal Capabilities this worker advertises. */
export type WorkerCapability = 'vone_executor_execute' | 'vone_inference_execute';
export const SUPPORTED_CAPABILITIES: readonly WorkerCapability[] = ['vone_executor_execute', 'vone_inference_execute'];

export function isSupportedCapability(value: unknown): value is WorkerCapability {
    return typeof value === 'string' && (SUPPORTED_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * @proposal Gate snapshot the worker reports with every heartbeat and result.
 * paid_blocked / unknown_cost reuse the observed field names; the other two
 * are proposal additions. The worker only ever REPORTS these - it never
 * accepts gate values from the Master (a job cannot unlock a gate).
 */
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

/** @proposal HTTP paths used by HttpMasterTransport - unverified. */
export const PROPOSED_HTTP_PATHS = Object.freeze({
    heartbeat: '/v1/execution/heartbeat',
    claim: '/v1/execution/claim',
    result: '/v1/execution/result',
});

/** @proposal Header carrying the contract version on every request. */
export const CONTRACT_HEADER = 'X-VOne-Contract';

/** @proposal */
export interface HeartbeatRequest {
    readonly contract: ExecutionContractVersion;
    readonly worker_id: string;
    readonly capabilities: readonly WorkerCapability[];
    readonly status: 'IDLE' | 'BUSY';
    readonly pending_results: number;
    readonly gates: ContractGates;
}

/** @proposal */
export interface HeartbeatResponse {
    readonly ok: boolean;
}

/** @proposal */
export interface ClaimRequest {
    readonly contract: ExecutionContractVersion;
    readonly worker_id: string;
    readonly capabilities: readonly WorkerCapability[];
}

/** @proposal Payload for capability `vone_executor_execute` -> VOneExecutor.execute(). */
export interface ExecutorJobPayload {
    readonly session_id: string;
    readonly objective: string;
}

/** @proposal Payload for capability `vone_inference_execute` -> one ModelRouter.dispatch(). */
export interface InferenceJobPayload {
    readonly prompt: string;
    readonly max_tokens?: number;
    readonly requires_physical_output?: boolean;
}

/**
 * @proposal A job as handed out by a successful claim. `capability` is kept
 * as a plain string on purpose: an unknown capability must reach the worker
 * so it can be REJECTED explicitly instead of being dropped by the parser.
 * `worker_id` is the owner the Master recorded for this lease.
 */
export interface JobEnvelope {
    readonly job_id: string;
    readonly task_id: string;
    readonly idempotency_key: string;
    readonly capability: string;
    readonly worker_id: string;
    readonly lease_id: string;
    /** epoch milliseconds */
    readonly lease_expires_at: number;
    readonly payload: Readonly<Record<string, unknown>>;
}

/** @proposal */
export interface ClaimResponse {
    readonly contract: ExecutionContractVersion;
    readonly job: JobEnvelope | null;
}

/** @proposal Outcome of a job from the worker's point of view. */
export type JobResultStatus = 'DONE' | 'BLOCKED' | 'FAILED' | 'INCOMPLETE' | 'REJECTED';

/**
 * @proposal NO_EVIDENCE_NO_PASS verdict. PASS requires status DONE *and*
 * evidence: for vone_executor_execute at least one artifact with a sha256
 * (the same rule the existing light-supervisor test applies); for
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

/**
 * @proposal The part of a result that is computed exactly once per
 * idempotency_key and replayed verbatim on any re-delivery.
 */
export interface ComputedJobResult {
    readonly idempotency_key: string;
    readonly task_id: string;
    readonly capability: string;
    readonly status: JobResultStatus;
    readonly output: JobOutput;
    readonly evidence: JobEvidence;
}

/** @proposal What the worker POSTs back; lease identifiers come from the current claim. */
export interface ResultSubmission extends ComputedJobResult {
    readonly contract: ExecutionContractVersion;
    readonly worker_id: string;
    readonly job_id: string;
    readonly lease_id: string;
    readonly replayed: boolean;
    readonly gates: ContractGates;
}

/** @proposal Rejection codes the mock Master uses. */
export type ResultRejectionReason = 'WRONG_WORKER' | 'LEASE_MISMATCH' | 'LEASE_EXPIRED' | 'UNKNOWN_JOB' | 'CONTRACT_MISMATCH';

/** @proposal */
export interface ResultAck {
    readonly accepted: boolean;
    readonly duplicate?: boolean;
    readonly reason?: ResultRejectionReason;
    /** Reuses the observed field name; semantics in this exchange unverified. */
    readonly checkpoint_revision?: number;
}

// ---------------------------------------------------------------------------
// Transport seam
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Runtime parsers for everything that crosses the wire from the Master.
// Unknown fields are dropped; nothing in a job can carry gate overrides.
// ---------------------------------------------------------------------------

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

function assertContract(record: Record<string, unknown>, what: string): void {
    if (record.contract !== EXECUTION_CONTRACT_VERSION) {
        throw new ContractViolationError(`${what}.contract must be ${EXECUTION_CONTRACT_VERSION}`);
    }
}

export function parseJobEnvelope(value: unknown): JobEnvelope {
    const record = asRecord(value, 'job');
    const leaseExpiresAt = record.lease_expires_at;
    if (typeof leaseExpiresAt !== 'number' || !Number.isFinite(leaseExpiresAt)) {
        throw new ContractViolationError('job.lease_expires_at must be a finite number (epoch ms)');
    }
    const payload = record.payload === undefined ? {} : asRecord(record.payload, 'job.payload');
    return {
        job_id: nonEmptyString(record, 'job_id', 'job'),
        task_id: nonEmptyString(record, 'task_id', 'job'),
        idempotency_key: nonEmptyString(record, 'idempotency_key', 'job'),
        capability: nonEmptyString(record, 'capability', 'job'),
        worker_id: nonEmptyString(record, 'worker_id', 'job'),
        lease_id: nonEmptyString(record, 'lease_id', 'job'),
        lease_expires_at: leaseExpiresAt,
        payload: { ...payload },
    };
}

export function parseClaimResponse(value: unknown): ClaimResponse {
    const record = asRecord(value, 'claim response');
    assertContract(record, 'claim response');
    return {
        contract: EXECUTION_CONTRACT_VERSION,
        job: record.job === null || record.job === undefined ? null : parseJobEnvelope(record.job),
    };
}

export function parseHeartbeatResponse(value: unknown): HeartbeatResponse {
    const record = asRecord(value, 'heartbeat response');
    if (typeof record.ok !== 'boolean') {
        throw new ContractViolationError('heartbeat response.ok must be a boolean');
    }
    return { ok: record.ok };
}

const REJECTION_REASONS: ReadonlySet<string> = new Set<ResultRejectionReason>([
    'WRONG_WORKER',
    'LEASE_MISMATCH',
    'LEASE_EXPIRED',
    'UNKNOWN_JOB',
    'CONTRACT_MISMATCH',
]);

export function parseResultAck(value: unknown): ResultAck {
    const record = asRecord(value, 'result ack');
    if (typeof record.accepted !== 'boolean') {
        throw new ContractViolationError('result ack.accepted must be a boolean');
    }
    if (record.reason !== undefined && (typeof record.reason !== 'string' || !REJECTION_REASONS.has(record.reason))) {
        throw new ContractViolationError('result ack.reason is not a known rejection code');
    }
    if (!record.accepted && record.reason === undefined) {
        throw new ContractViolationError('a rejected result ack must carry a reason');
    }
    return {
        accepted: record.accepted,
        duplicate: record.duplicate === true ? true : undefined,
        reason: record.reason as ResultRejectionReason | undefined,
        checkpoint_revision: typeof record.checkpoint_revision === 'number' ? record.checkpoint_revision : undefined,
    };
}

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
