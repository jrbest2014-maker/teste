import { VOneUnifiedHubAgent } from './vone_unified_hub_agent';
import { VOneHydrationEngine } from './vone_hydration_engine';
import { RoutingBlockedError } from '../server/vone_model_router';

export type AgentStatus = 'IDLE' | 'RUNNING' | 'DONE' | 'BLOCKED' | 'FAILED' | 'INCOMPLETE';

export type AgentToolName = 'read_file' | 'write_file' | 'execute_command';

export type AgentDecision =
    | { action: 'tool'; toolName: AgentToolName; arguments: Record<string, unknown> }
    | { action: 'finish'; summary: string };

export interface AgentStepRecord {
    readonly step: number;
    readonly decisionRaw: string;
    readonly decision: AgentDecision | null;
    readonly observation: string;
}

export interface VOneAgentState {
    sessionId: string;
    currentObjective: string;
    stepsHistory: AgentStepRecord[];
    status: AgentStatus;
}

export interface VOneAgentLoopOptions {
    readonly maxSteps?: number;
    readonly maxConsecutiveParseFailures?: number;
}

const DEFAULT_MAX_STEPS = 20;
const DEFAULT_MAX_PARSE_FAILURES = 2;
const HISTORY_WINDOW = 8;
const OBSERVATION_TRUNCATE_LENGTH = 500;

/**
 * Drives VOneUnifiedHubAgent through a bounded plan-act loop: each step asks
 * the model (through the hub's gated ModelRouter) what to do next given the
 * objective and history so far, executes that one tool call through the
 * hub's sandboxed interpreter, and persists progress after every step so a
 * later run() with the same sessionId resumes instead of restarting.
 *
 * A RoutingBlockedError (paid tier, unknown cost, physical output) stops
 * the loop immediately rather than being retried - those are policy gates,
 * not transient failures, and this loop never works around them.
 */
export class VOneAgentLoop {
    private readonly maxSteps: number;
    private readonly maxConsecutiveParseFailures: number;

    constructor(
        private readonly hub: VOneUnifiedHubAgent,
        private readonly hydration: VOneHydrationEngine,
        options: VOneAgentLoopOptions = {},
    ) {
        this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
        this.maxConsecutiveParseFailures = options.maxConsecutiveParseFailures ?? DEFAULT_MAX_PARSE_FAILURES;
    }

    public async run(sessionId: string, objective: string): Promise<VOneAgentState> {
        const state = this.hydration.hydrate(sessionId, objective) as VOneAgentState;

        if (state.status === 'DONE') {
            return state;
        }

        state.status = 'RUNNING';
        let consecutiveParseFailures = 0;

        while (state.stepsHistory.length < this.maxSteps) {
            let decisionRaw: string;
            try {
                const result = await this.hub.askModel({ prompt: this.buildPrompt(state) });
                decisionRaw = result.text;
            } catch (error) {
                if (error instanceof RoutingBlockedError) {
                    state.status = 'BLOCKED';
                    state.stepsHistory.push({
                        step: state.stepsHistory.length,
                        decisionRaw: '',
                        decision: null,
                        observation: `[BLOCKED]: ${error.reason}`,
                    });
                    this.hydration.dehydrate(state);
                    return state;
                }
                throw error;
            }

            const decision = this.parseDecision(decisionRaw);

            if (decision === null) {
                consecutiveParseFailures += 1;
                state.stepsHistory.push({
                    step: state.stepsHistory.length,
                    decisionRaw,
                    decision: null,
                    observation: '[PARSE ERROR]: Model response was not a valid decision object.',
                });

                if (consecutiveParseFailures >= this.maxConsecutiveParseFailures) {
                    state.status = 'FAILED';
                    this.hydration.dehydrate(state);
                    return state;
                }
                this.hydration.dehydrate(state);
                continue;
            }
            consecutiveParseFailures = 0;

            if (decision.action === 'finish') {
                state.stepsHistory.push({
                    step: state.stepsHistory.length,
                    decisionRaw,
                    decision,
                    observation: decision.summary,
                });
                state.status = 'DONE';
                this.hydration.dehydrate(state);
                return state;
            }

            const observation = await this.hub.orchestrateExternalTool(decision.toolName, {
                toolName: decision.toolName,
                arguments: decision.arguments,
            });

            state.stepsHistory.push({
                step: state.stepsHistory.length,
                decisionRaw,
                decision,
                observation,
            });
            this.hydration.dehydrate(state);
        }

        state.status = 'INCOMPLETE';
        this.hydration.dehydrate(state);
        return state;
    }

    private buildPrompt(state: VOneAgentState): string {
        const recentSteps = state.stepsHistory.slice(-HISTORY_WINDOW);
        const historyText = recentSteps.length
            ? recentSteps
                  .map((record) => {
                      const decisionSummary = record.decision ? JSON.stringify(record.decision) : '(unparseable response)';
                      return `Step ${record.step}: decided ${decisionSummary} -> observed: ${truncate(record.observation, OBSERVATION_TRUNCATE_LENGTH)}`;
                  })
                  .join('\n')
            : 'No steps taken yet.';

        return [
            'You are V-ONE, an autonomous coding agent operating strictly inside a sandboxed project root.',
            `Objective: ${state.currentObjective}`,
            historyText,
            'Respond with EXACTLY one JSON object on a single line - no prose, no markdown fences.',
            'Either: {"action":"tool","toolName":"read_file"|"write_file"|"execute_command","arguments":{...}}',
            'Or, once the objective is complete: {"action":"finish","summary":"<what you did>"}',
        ].join('\n\n');
    }

    private parseDecision(rawText: string): AgentDecision | null {
        let parsed: unknown;
        try {
            parsed = JSON.parse(rawText.trim());
        } catch {
            return null;
        }

        if (!parsed || typeof parsed !== 'object') return null;
        const candidate = parsed as Record<string, unknown>;

        if (candidate.action === 'finish' && typeof candidate.summary === 'string') {
            return { action: 'finish', summary: candidate.summary };
        }

        if (
            candidate.action === 'tool' &&
            (candidate.toolName === 'read_file' ||
                candidate.toolName === 'write_file' ||
                candidate.toolName === 'execute_command') &&
            typeof candidate.arguments === 'object' &&
            candidate.arguments !== null
        ) {
            return {
                action: 'tool',
                toolName: candidate.toolName,
                arguments: candidate.arguments as Record<string, unknown>,
            };
        }

        return null;
    }
}

function truncate(text: string, maxLength: number): string {
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}
