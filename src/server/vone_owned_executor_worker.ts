import type { VOneExecutor } from './vone_executor';
import {
    assertExecutionContractRequest,
    type VOneExecutionContractRequest,
    type VOneExecutionContractResult,
} from './vone_execution_contract';

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

export interface OwnedExecutorWorkerOptions {
    readonly workerId: string;
    readonly executor: Pick<VOneExecutor, 'execute'>;
    readonly master: MasterWorkerClient;
}

export class VOneOwnedExecutorWorker {
    constructor(private readonly options: OwnedExecutorWorkerOptions) {}

    public async heartbeat(): Promise<void> {
        await this.options.master.heartbeat({
            mode: 'ONLINE',
            role: 'OWNED_EXECUTOR',
            capabilities: ['vone_executor_execute'],
            execution_contracts: ['VONE_EXECUTION_CONTRACT_R1'],
        });
    }

    public async runOnce(): Promise<'IDLE' | 'DONE' | 'FAILED'> {
        const job = await this.options.master.claim();
        if (!job) return 'IDLE';

        if (job.toolName !== 'vone_executor_execute') {
            await this.options.master.error(job.id, 'unsupported_tool');
            return 'FAILED';
        }

        try {
            assertExecutionContractRequest(job.arguments);
            const request: VOneExecutionContractRequest = job.arguments;
            const result = await this.options.executor.execute({
                sessionId: request.idempotency_key,
                taskId: request.task_id,
                objective: request.objective,
            });

            if (result.state.checkpointRevision < request.checkpoint_revision) {
                throw new Error('stale_executor_checkpoint');
            }

            const payload: VOneExecutionContractResult = {
                protocol: 'VONE_EXECUTION_CONTRACT_R1',
                status: result.state.status === 'IDLE' || result.state.status === 'RUNNING'
                    ? 'INCOMPLETE'
                    : result.state.status,
                run_id: result.telemetry.runId,
                task_id: request.task_id,
                checkpoint_revision: result.state.checkpointRevision,
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
                },
            };

            await this.options.master.result(job.id, payload);
            return 'DONE';
        } catch (error) {
            const message = error instanceof Error ? error.message : 'executor_failure';
            await this.options.master.error(job.id, message);
            return 'FAILED';
        }
    }
}
