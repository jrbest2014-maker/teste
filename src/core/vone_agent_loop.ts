import { createHash, randomUUID } from 'node:crypto';
import { VOneHydrationEngine } from './vone_hydration_engine';
import { redactSecrets } from './vone_secret_redaction';
import { RoutingBlockedError, type InferenceRequest, type InferenceResult, type RoutingBlockReason } from '../server/vone_model_router';

export type AgentStatus = 'IDLE' | 'RUNNING' | 'DONE' | 'BLOCKED' | 'FAILED' | 'INCOMPLETE';

export type AgentToolName = 'read_file' | 'write_file' | 'execute_command';

const ALLOWED_TOOL_NAMES: ReadonlySet<string> = new Set<AgentToolName>(['read_file', 'write_file', 'execute_command']);

export type AgentDecision =
    | { action: 'tool'; toolName: AgentToolName; arguments: Record<string, unknown>; idempotencyKey?: string }
    | { action: 'finish'; summary: string };

export interface AgentStepRecord {
    readonly step: number;
    /** The model's literal text when it failed to parse; for a successfully
     *  parsed decision, a redacted re-serialization of it instead - JSON
     *  string-escaping (\") defeats plain-text secret patterns, so redacting
     *  the parsed object and re-stringifying it is what actually closes
     *  that gap rather than redacting the original text in place. */
    readonly decisionRaw: string;
    readonly decision: AgentDecision | null;
    readonly observation: string;
}

export interface ArtifactRecord {
    readonly step: number;
    readonly path: string;
    readonly sha256: string;
}

export interface VOneAgentState {
    sessionId: string;
    currentObjective: string;
    stepsHistory: AgentStepRecord[];
    status: AgentStatus;
    checkpointRevision: number;
    executedActionKeys: Record<string, string>;
    artifacts: ArtifactRecord[];
}

/**
 * The hub-shaped surface VOneAgentLoop depends on - satisfied structurally
 * by VOneUnifiedHubAgent (no import needed) and by any test double. The
 * loop never imports a concrete hub, model provider, or router
 * implementation, so it stays reusable by any executor that can supply
 * something with this shape.
 */
export interface AgentHub {
    askModel(request: InferenceRequest): Promise<InferenceResult>;
    orchestrateExternalTool(type: string, params: unknown): Promise<string>;
}

export interface GateDecisionRecord {
    readonly step: number;
    readonly category: RoutingBlockReason;
    readonly reason: string;
}

export type RunErrorClass = 'None' | 'RoutingBlocked' | 'ParseError' | 'UnauthorizedTool' | 'MaxStepsExceeded';

/**
 * Per-run telemetry. Deliberately excludes prompt text, tool arguments,
 * and raw observations - only identifiers, counts, and outcomes, so this
 * can be logged or exported without carrying whatever a step happened to
 * read or write. Emitted exactly once per run() call, at whichever exit
 * point that call reaches.
 */
export interface RunTelemetry {
    readonly runId: string;
    readonly taskId: string;
    readonly sessionId: string;
    readonly routeId: string | null;
    readonly model: string | null;
    readonly stepCount: number;
    readonly status: AgentStatus;
    readonly elapsedMs: number;
    readonly checkpointRevision: number;
    readonly artifactHashes: readonly string[];
    readonly gateDecisions: readonly GateDecisionRecord[];
    readonly errorClass: RunErrorClass;
}

export interface VOneAgentLoopOptions {
    readonly maxSteps?: number;
    readonly maxConsecutiveParseFailures?: number;
    readonly onTelemetry?: (event: RunTelemetry) => void;
}

const DEFAULT_MAX_STEPS = 20;
const DEFAULT_MAX_PARSE_FAILURES = 2;
const HISTORY_WINDOW = 8;
const OBSERVATION_TRUNCATE_LENGTH = 500;

type DecisionParseOutcome =
    | { kind: 'decision'; decision: AgentDecision }
    | { kind: 'invalid_json' }
    | { kind: 'unauthorized_tool'; toolName: string };

/**
 * Drives an AgentHub through a bounded plan-act loop: each step asks the
 * model what to do next given the objective and history so far, executes
 * that one tool call, and persists progress after every step so a later
 * run() with the same sessionId resumes instead of restarting. A session
 * already DONE returns immediately without calling the model again.
 *
 * A RoutingBlockedError (paid tier, unknown cost, physical output) stops
 * the loop immediately rather than being retried - those are policy gates
 * owned entirely by whatever sits behind AgentHub.askModel, not this loop;
 * it only reacts to the outcome, it never re-derives or overrides it.
 *
 * Two more failure modes are bounded rather than left to spin: an
 * unparseable or unauthorized-tool response counts against a shared
 * rejection budget (FAILED once exhausted), and a model that never emits
 * {"action":"finish",...} is stopped at maxSteps (INCOMPLETE).
 *
 * Side-effecting tool calls are idempotent within and across resumes: the
 * same {toolName, arguments} pair (or an explicit idempotencyKey from the
 * model) executes at most once per session - a repeated decision replays
 * the cached observation instead of re-running the tool. write_file
 * results are recorded in an artifact ledger (path + content hash) that
 * survives resume. All persisted/prompted text passes through
 * redactSecrets() first - a best-effort net, not a guarantee.
 */
export class VOneAgentLoop {
    private readonly maxSteps: number;
    private readonly maxConsecutiveParseFailures: number;
    private readonly onTelemetry?: (event: RunTelemetry) => void;

    constructor(
        private readonly hub: AgentHub,
        private readonly hydration: VOneHydrationEngine,
        options: VOneAgentLoopOptions = {},
    ) {
        this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
        this.maxConsecutiveParseFailures = options.maxConsecutiveParseFailures ?? DEFAULT_MAX_PARSE_FAILURES;
        this.onTelemetry = options.onTelemetry;
    }

    public async run(sessionId: string, objective: string, taskId: string = sessionId): Promise<VOneAgentState> {
        const state = this.hydrateState(sessionId, objective);
        const runId = randomUUID();
        const startedAt = Date.now();
        const gateDecisions: GateDecisionRecord[] = [];
        let lastRoute: { routeId: string; model: string } | null = null;

        if (state.status === 'DONE') {
            this.emitTelemetry({ state, runId, taskId, startedAt, lastRoute, gateDecisions, errorClass: 'None' });
            return state;
        }

        state.status = 'RUNNING';
        let consecutiveRejections = 0;

        while (state.stepsHistory.length < this.maxSteps) {
            let decisionRaw: string;
            try {
                const result = await this.hub.askModel({ prompt: this.buildPrompt(state) });
                decisionRaw = result.text;
                lastRoute = { routeId: result.routeId, model: result.model };
            } catch (error) {
                if (error instanceof RoutingBlockedError) {
                    gateDecisions.push({
                        step: state.stepsHistory.length,
                        category: error.category,
                        reason: error.reason,
                    });
                    state.status = 'BLOCKED';
                    state.stepsHistory.push({
                        step: state.stepsHistory.length,
                        decisionRaw: '',
                        decision: null,
                        observation: `[BLOCKED]: ${error.reason}`,
                    });
                    this.persist(state);
                    this.emitTelemetry({
                        state,
                        runId,
                        taskId,
                        startedAt,
                        lastRoute,
                        gateDecisions,
                        errorClass: 'RoutingBlocked',
                    });
                    return state;
                }
                throw error;
            }

            const outcome = this.parseDecision(decisionRaw);

            if (outcome.kind === 'invalid_json' || outcome.kind === 'unauthorized_tool') {
                consecutiveRejections += 1;
                state.stepsHistory.push({
                    step: state.stepsHistory.length,
                    decisionRaw: redactSecrets(decisionRaw),
                    decision: null,
                    observation:
                        outcome.kind === 'invalid_json'
                            ? '[PARSE ERROR]: Model response was not a valid decision object.'
                            : `[UNAUTHORIZED TOOL]: "${outcome.toolName}" is not in the allowed tool set.`,
                });

                if (consecutiveRejections >= this.maxConsecutiveParseFailures) {
                    state.status = 'FAILED';
                    this.persist(state);
                    this.emitTelemetry({
                        state,
                        runId,
                        taskId,
                        startedAt,
                        lastRoute,
                        gateDecisions,
                        errorClass: outcome.kind === 'invalid_json' ? 'ParseError' : 'UnauthorizedTool',
                    });
                    return state;
                }
                this.persist(state);
                continue;
            }
            consecutiveRejections = 0;

            const decision = outcome.decision;

            if (decision.action === 'finish') {
                const redactedDecision = redactDecisionForStorage(decision);
                state.stepsHistory.push({
                    step: state.stepsHistory.length,
                    decisionRaw: JSON.stringify(redactedDecision),
                    decision: redactedDecision,
                    observation: redactSecrets(decision.summary),
                });
                state.status = 'DONE';
                this.persist(state);
                this.emitTelemetry({ state, runId, taskId, startedAt, lastRoute, gateDecisions, errorClass: 'None' });
                return state;
            }

            const idempotencyKey = decision.idempotencyKey ?? computeIdempotencyKey(decision.toolName, decision.arguments);
            let observation: string;

            if (Object.prototype.hasOwnProperty.call(state.executedActionKeys, idempotencyKey)) {
                observation = `[IDEMPOTENT REPLAY]: ${state.executedActionKeys[idempotencyKey]}`;
            } else {
                const rawObservation = await this.hub.orchestrateExternalTool(decision.toolName, {
                    toolName: decision.toolName,
                    arguments: decision.arguments,
                });
                observation = redactSecrets(rawObservation);
                state.executedActionKeys[idempotencyKey] = observation;

                if (
                    decision.toolName === 'write_file' &&
                    observation === '[SUCCESS]' &&
                    typeof decision.arguments.content === 'string'
                ) {
                    state.artifacts.push({
                        step: state.stepsHistory.length,
                        path: typeof decision.arguments.path === 'string' ? decision.arguments.path : '',
                        sha256: sha256Hex(decision.arguments.content),
                    });
                }
            }

            const redactedDecision = redactDecisionForStorage(decision);
            state.stepsHistory.push({
                step: state.stepsHistory.length,
                decisionRaw: JSON.stringify(redactedDecision),
                decision: redactedDecision,
                observation,
            });
            this.persist(state);
        }

        state.status = 'INCOMPLETE';
        this.persist(state);
        this.emitTelemetry({ state, runId, taskId, startedAt, lastRoute, gateDecisions, errorClass: 'MaxStepsExceeded' });
        return state;
    }

    private hydrateState(sessionId: string, objective: string): VOneAgentState {
        const hydrated = this.hydration.hydrate(sessionId, objective) as Partial<VOneAgentState> &
            Pick<VOneAgentState, 'sessionId' | 'currentObjective' | 'stepsHistory' | 'status'>;
        hydrated.checkpointRevision = hydrated.checkpointRevision ?? 0;
        hydrated.executedActionKeys = hydrated.executedActionKeys ?? {};
        hydrated.artifacts = hydrated.artifacts ?? [];
        return hydrated as VOneAgentState;
    }

    private persist(state: VOneAgentState): void {
        state.checkpointRevision += 1;
        this.hydration.dehydrate(state);
    }

    private emitTelemetry(params: {
        state: VOneAgentState;
        runId: string;
        taskId: string;
        startedAt: number;
        lastRoute: { routeId: string; model: string } | null;
        gateDecisions: GateDecisionRecord[];
        errorClass: RunErrorClass;
    }): void {
        if (!this.onTelemetry) return;
        const { state, runId, taskId, startedAt, lastRoute, gateDecisions, errorClass } = params;
        this.onTelemetry({
            runId,
            taskId,
            sessionId: state.sessionId,
            routeId: lastRoute?.routeId ?? null,
            model: lastRoute?.model ?? null,
            stepCount: state.stepsHistory.length,
            status: state.status,
            elapsedMs: Date.now() - startedAt,
            checkpointRevision: state.checkpointRevision,
            artifactHashes: state.artifacts.map((artifact) => artifact.sha256),
            gateDecisions,
            errorClass,
        });
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

    private parseDecision(rawText: string): DecisionParseOutcome {
        let parsed: unknown;
        try {
            parsed = JSON.parse(rawText.trim());
        } catch {
            return { kind: 'invalid_json' };
        }

        if (!parsed || typeof parsed !== 'object') return { kind: 'invalid_json' };
        const candidate = parsed as Record<string, unknown>;

        if (candidate.action === 'finish' && typeof candidate.summary === 'string') {
            return { kind: 'decision', decision: { action: 'finish', summary: candidate.summary } };
        }

        if (candidate.action === 'tool' && typeof candidate.toolName === 'string') {
            if (!ALLOWED_TOOL_NAMES.has(candidate.toolName)) {
                return { kind: 'unauthorized_tool', toolName: candidate.toolName };
            }
            if (typeof candidate.arguments !== 'object' || candidate.arguments === null) {
                return { kind: 'invalid_json' };
            }
            return {
                kind: 'decision',
                decision: {
                    action: 'tool',
                    toolName: candidate.toolName as AgentToolName,
                    arguments: candidate.arguments as Record<string, unknown>,
                    idempotencyKey: typeof candidate.idempotencyKey === 'string' ? candidate.idempotencyKey : undefined,
                },
            };
        }

        return { kind: 'invalid_json' };
    }
}

/**
 * A redacted copy for storage/prompting only. The caller keeps using the
 * original, unredacted decision to execute the tool and to compute the
 * idempotency key - hashing or dispatching a redacted value would both
 * corrupt the write (content would become the literal text "[REDACTED]")
 * and cause unrelated actions that merely look like secrets to collide.
 */
function redactDecisionForStorage(decision: AgentDecision): AgentDecision {
    if (decision.action === 'finish') {
        return { action: 'finish', summary: redactSecrets(decision.summary) };
    }
    const redactedArguments: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(decision.arguments)) {
        redactedArguments[key] = typeof value === 'string' ? redactSecrets(value) : value;
    }
    return { ...decision, arguments: redactedArguments };
}

function computeIdempotencyKey(toolName: AgentToolName, args: Record<string, unknown>): string {
    return createHash('sha256').update(`${toolName}:${stableStringify(args)}`).digest('hex');
}

function sha256Hex(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const keys = Object.keys(value as Record<string, unknown>).sort();
        return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function truncate(text: string, maxLength: number): string {
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}
