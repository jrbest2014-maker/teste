export type VOneExecutionStatus = 'DONE' | 'BLOCKED' | 'FAILED' | 'INCOMPLETE';

export interface VOneExecutionContractRequest {
    readonly protocol: 'VONE_EXECUTION_CONTRACT_R1';
    readonly mission_id: string;
    readonly task_id: string;
    readonly checkpoint_revision: number;
    readonly objective: string;
    readonly idempotency_key: string;
    readonly capacity_snapshot?: Readonly<Record<string, unknown>> | null;
}

export interface VOneExecutionEvidence {
    readonly executor: 'VOneExecutor';
    readonly session_id: string;
    readonly artifact_count: number;
}

export interface VOneExecutionContractResult {
    readonly protocol: 'VONE_EXECUTION_CONTRACT_R1';
    readonly status: VOneExecutionStatus;
    readonly run_id: string;
    readonly task_id: string;
    readonly checkpoint_revision: number;
    readonly route_id: string | null;
    readonly model: string | null;
    readonly step_count: number;
    readonly elapsed_ms: number;
    readonly artifact_hashes: readonly string[];
    readonly gate_decisions: readonly { readonly step: number; readonly category: string; readonly reason: string }[];
    readonly error_class: string;
    readonly evidence: VOneExecutionEvidence;
}

export function assertExecutionContractRequest(value: unknown): asserts value is VOneExecutionContractRequest {
    if (!value || typeof value !== 'object') throw new Error('execution_contract_request_required');
    const v = value as Record<string, unknown>;
    if (v.protocol !== 'VONE_EXECUTION_CONTRACT_R1') throw new Error('unsupported_execution_contract');
    for (const key of ['mission_id', 'task_id', 'objective', 'idempotency_key'] as const) {
        if (typeof v[key] !== 'string' || !(v[key] as string).trim()) throw new Error(`${key}_required`);
    }
    if (!Number.isInteger(v.checkpoint_revision) || Number(v.checkpoint_revision) < 0) {
        throw new Error('checkpoint_revision_invalid');
    }
}
