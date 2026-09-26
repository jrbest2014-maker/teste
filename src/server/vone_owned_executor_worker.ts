import type { VOneExecutor } from './vone_executor';
import {
    assertExecutionContractRequest,
    type VOneExecutionContractRequest,
    type VOneExecutionContractResult,
} from './vone_execution_contract';
import {
    assertVerifiedCapacitySnapshot,
    CapacitySnapshotBlockedError,
} from './vone_capacity_snapshot';

export interface MasterWorkerJob {
    readonly id: string;
    readonly toolName: string;
    readonly arguments?: unknown;
}

export interface MasterWorkerClient {
    heartbeat(statusPayload: Readonly<Record<string, unknown>>): Promise<void>;
    claim(): Promise<MasterWorkerJob | null>;
    result(jobId: string, result: unknown): Promise<void>;
    error(jobId: string, message: string): Promise<void>;
}

type ExecutorLike = Pick<VOneExecutor, 'execute'>;
export type VOneExecutorFactory = (
    request: VOneExecutionContractRequest,
) => ExecutorLike | Promise<ExecutorLike>;

export interface OwnedExecutorWorkerOptions {
    readonly workerId: string;
    readonly master: MasterWorkerClient;
    readonly executor?: ExecutorLike;
    readonly executorFactory?: VOneExecutorFactory;
    readonly heartbeatDetails?: Readonly<Record<string, unknown>>;
    readonly capacityValidation?: {
        readonly maxSnapshotAgeMs?: number;
        readonly expectedProviderContains?: string;
        readonly preferredModel?: string;
    };
}

export class VOneOwnedExecutorWorker {
    private activeJobId: string | null = null;

    constructor(private readonly options: OwnedExecutorWorkerOptions) {
        if (!options.executor && !options.executorFactory) {
            throw new Error('executor_or_factory_required');
        }
    }

    public async heartbeat(): Promise<void> {
        await this.options.master.heartbeat({
            mode: 'ONLINE',
            role: 'OWNED_EXECUTOR',
            capabilities: ['vone_executor_execute'],
            execution_contracts: ['VONE_EXECUTION_CONTRACT_R1'],
            active_job_id: this.activeJobId,
            ...(this.options.heartbeatDetails ?? {}),
        });
    }

    public async runOnce(): Promise<'IDLE' | 'DONE' | 'BLOCKED' | 'FAILED'> {
        const job = await this.options.master.claim();
        if (!job) return 'IDLE';

        if (job.toolName !== 'vone_executor_execute') {
            await this.options.master.error(job.id, 'unsupported_tool');
            return 'FAILED';
        }

        this.activeJobId = job.id;
        try {
            assertExecutionContractRequest(job.arguments);
            const request: VOneExecutionContractRequest = job.arguments;

            try {
                assertVerifiedCapacitySnapshot(request.capacity_snapshot, this.options.capacityValidation);
            } catch (error) {
                if (error instanceof CapacitySnapshotBlockedError) {
                    const payload: VOneExecutionContractResult = {
                        protocol: 'VONE_EXECUTION_CONTRACT_R1',
                        status: 'BLOCKED',
                        run_id: `blocked_${job.id}`,
                        task_id: request.task_id,
                        checkpoint_revision: request.checkpoint_revision,
                        route_id: request.capacity_snapshot?.selected?.route_id ?? null,
                        model: null,
                        step_count: 0,
                        elapsed_ms: 0,
                        artifact_hashes: [],
                        gate_decisions: [{ step: 0, category: 'capacity_snapshot', reason: error.code }],
                        error_class: error.code,
                        evidence: {
                            executor: 'VOneExecutor',
                            session_id: request.idempotency_key,
                            artifact_count: 0,
                            local_checkpoint_revision: 0,
                        },
                    };
                    await this.options.master.result(job.id, payload);
                    return 'BLOCKED';
                }
                throw error;
            }

            const executor = this.options.executorFactory
                ? await this.options.executorFactory(request)
                : this.options.executor!;

            const result = await executor.execute({
                sessionId: request.idempotency_key,
                taskId: request.task_id,
                objective: request.objective,
            });

            const payload: VOneExecutionContractResult = {
                protocol: 'VONE_EXECUTION_CONTRACT_R1',
                status: result.state.status === 'IDLE' || result.state.status === 'RUNNING'
                    ? 'INCOMPLETE'
                    : result.state.status,
                run_id: result.telemetry.runId,
                task_id: request.task_id,
                checkpoint_revision: request.checkpoint_revision,
                route_id: result.telemetry.routeId,
                model: result.telemetry.model,
                step_count: result.telemetry.stepCount,
                elapsed_ms: result.telemetry.elapsedMs,
                artifact_hashes: result.telemetry.artifactHashes,
                gate_decisions: result.telemetry.gateDecisions,
                error_class: result.telemetry.errorClass,
                evidence: {
                    executor: 'VOneExecutor',
                    session_id: result.state.sessionId,
                    artifact_count: result.state.artifacts.length,
                    local_checkpoint_revision: result.state.checkpointRevision,
                },
            };

            await this.options.master.result(job.id, payload);
            return payload.status === 'BLOCKED' ? 'BLOCKED' : 'DONE';
        } catch (error) {
            const message = error instanceof Error ? error.message : 'executor_failure';
            await this.options.master.error(job.id, message);
            return 'FAILED';
        } finally {
            this.activeJobId = null;
        }
    }
}
