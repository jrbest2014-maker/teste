import { VOneHydrationEngine } from '../core/vone_hydration_engine';
import {
    VOneAgentLoop,
    type AgentHub,
    type RunTelemetry,
    type VOneAgentState,
    type VOneAgentLoopOptions,
} from '../core/vone_agent_loop';

export interface ExecutorRequest {
    readonly sessionId: string;
    readonly objective: string;
    readonly taskId?: string;
}

export interface ExecutorResult {
    readonly state: VOneAgentState;
    readonly telemetry: RunTelemetry;
}

export type ExecutorOptions = Omit<VOneAgentLoopOptions, 'onTelemetry'>;

/**
 * The single, stable surface an external orchestrator (e.g. a
 * vone_delegate_execute handler acting as a lightweight supervisor) calls
 * to run one objective through the autonomous core. This class adapts
 * VOneAgentLoop's callback-based telemetry into one awaited result and
 * gives integrators a single name to depend on - it does not reimplement
 * routing or gate logic. Every decision still flows through
 * VOneAgentLoop -> AgentHub -> ModelRouter exactly as it would if the loop
 * were driven directly; a supervisor calling execute() once gets the same
 * gate enforcement and delegates all step-by-step reasoning to the loop.
 */
export class VOneExecutor {
    constructor(
        private readonly hub: AgentHub,
        private readonly hydration: VOneHydrationEngine,
        private readonly loopOptions: ExecutorOptions = {},
    ) {}

    public async execute(request: ExecutorRequest): Promise<ExecutorResult> {
        let telemetry: RunTelemetry | undefined;
        const loop = new VOneAgentLoop(this.hub, this.hydration, {
            ...this.loopOptions,
            onTelemetry: (event) => {
                telemetry = event;
            },
        });

        const state = await loop.run(request.sessionId, request.objective, request.taskId ?? request.sessionId);

        if (!telemetry) {
            throw new Error('[EXECUTOR ERROR]: VOneAgentLoop completed without emitting telemetry.');
        }

        return { state, telemetry };
    }
}
