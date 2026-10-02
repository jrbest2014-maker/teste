import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VOneVFSSandbox } from './vone_vfs_sandbox';
import { VOneHydrationEngine } from './vone_hydration_engine';
import { VOneUnifiedHubAgent } from './vone_unified_hub_agent';
import { VOneAgentLoop, type AgentHub, type RunTelemetry } from './vone_agent_loop';
import {
    ModelRouter,
    createDefaultGates,
    type InferenceRequest,
    type InferenceResult,
    type ModelCaller,
    type ModelRoute,
} from '../server/vone_model_router';

class ScriptedCaller implements ModelCaller {
    public callCount = 0;
    private index = 0;
    constructor(private readonly responses: string[]) {}

    public async run(_route: ModelRoute, _request: InferenceRequest) {
        this.callCount += 1;
        const text = this.responses[Math.min(this.index, this.responses.length - 1)];
        this.index += 1;
        return { text, neuronsUsed: 1 };
    }
}

/** A hand-written AgentHub double for tests that need to count real tool
 * invocations precisely (idempotency, unauthorized-tool blocking) without
 * a real sandbox in the way. */
class SpyHub implements AgentHub {
    public modelCalls = 0;
    public toolCalls: Array<{ type: string; params: unknown }> = [];
    private index = 0;
    constructor(private readonly decisions: string[]) {}

    public async askModel(_request: InferenceRequest): Promise<InferenceResult> {
        this.modelCalls += 1;
        const text = this.decisions[Math.min(this.index, this.decisions.length - 1)];
        this.index += 1;
        return { routeId: 'spy-route', model: 'spy-model', text, neuronsUsed: 1 };
    }

    public async orchestrateExternalTool(type: string, params: unknown): Promise<string> {
        this.toolCalls.push({ type, params });
        return '[SPY OK]';
    }
}

function freeRoute(id = 'test-free-route'): ModelRoute {
    return {
        id,
        tier: 'free',
        model: 'test-model',
        costPerMTokUsd: 0,
        state: 'FREE_AVAILABLE',
        neuronsUsedToday: 0,
    };
}

function paidRoute(id = 'test-paid-route'): ModelRoute {
    return {
        id,
        tier: 'paid',
        model: 'paid-model',
        costPerMTokUsd: 5,
        state: 'FREE_AVAILABLE', // pretend "available" - the tier gate must block it regardless.
        neuronsUsedToday: 0,
    };
}

function sha256(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function main(): Promise<void> {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vone-agent-loop-'));
    try {
        const sandbox = new VOneVFSSandbox(tmpRoot);
        const hydration = new VOneHydrationEngine(sandbox);

        // 1. FREE_AVAILABLE route works: happy path reaches DONE, and per-run
        //    telemetry reports the route actually used and a clean error class.
        {
            const caller = new ScriptedCaller([
                '{"action":"tool","toolName":"write_file","arguments":{"path":"out.txt","content":"hi"}}',
                '{"action":"tool","toolName":"read_file","arguments":{"path":"out.txt"}}',
                '{"action":"finish","summary":"wrote and read out.txt"}',
            ]);
            const router = new ModelRouter([freeRoute()], createDefaultGates(), caller);
            const hub = new VOneUnifiedHubAgent(sandbox, router);
            let telemetry: RunTelemetry | undefined;
            const loop = new VOneAgentLoop(hub, hydration, { onTelemetry: (event) => (telemetry = event) });

            const state = await loop.run('session-happy', 'write and read out.txt');
            assert.equal(state.status, 'DONE');
            assert.equal(state.stepsHistory.length, 3);
            assert.equal(state.stepsHistory[1].observation, 'hi');
            assert.equal(caller.callCount, 3);
            assert.equal(telemetry?.routeId, 'test-free-route');
            assert.equal(telemetry?.status, 'DONE');
            assert.equal(telemetry?.errorClass, 'None');
            assert.equal(telemetry?.stepCount, 3);
            assert.equal(telemetry?.checkpointRevision, state.checkpointRevision);

            // Resuming a DONE session returns immediately - no model call, no new steps.
            const resumed = await loop.run('session-happy', 'write and read out.txt');
            assert.equal(resumed.status, 'DONE');
            assert.equal(resumed.stepsHistory.length, 3);
            assert.equal(caller.callCount, 3);
        }

        // 2. PAID_BLOCKED never executes, even when it's the only route offered.
        {
            const caller = new ScriptedCaller(['{"action":"finish","summary":"unreachable"}']);
            const router = new ModelRouter([paidRoute()], createDefaultGates(), caller);
            const hub = new VOneUnifiedHubAgent(sandbox, router);
            let telemetry: RunTelemetry | undefined;
            const loop = new VOneAgentLoop(hub, hydration, { onTelemetry: (event) => (telemetry = event) });

            const state = await loop.run('session-paid-blocked', 'spend money');
            assert.equal(state.status, 'BLOCKED');
            assert.equal(state.stepsHistory.length, 1);
            assert.match(state.stepsHistory[0].observation, /\[BLOCKED\]/);
            assert.equal(caller.callCount, 0);
            assert.equal(telemetry?.errorClass, 'RoutingBlocked');
            assert.equal(telemetry?.gateDecisions[0]?.category, 'paidBlocked');
        }

        // 3. Unknown per-token cost => HOLD/BLOCKED, never assumed free.
        {
            const unknownCostRoute: ModelRoute = { ...freeRoute('unknown-cost-route'), costPerMTokUsd: null };
            const caller = new ScriptedCaller(['{"action":"finish","summary":"unreachable"}']);
            const router = new ModelRouter([unknownCostRoute], createDefaultGates(), caller);
            const hub = new VOneUnifiedHubAgent(sandbox, router);
            let telemetry: RunTelemetry | undefined;
            const loop = new VOneAgentLoop(hub, hydration, { onTelemetry: (event) => (telemetry = event) });

            const state = await loop.run('session-unknown-cost', 'do something costly');
            assert.equal(state.status, 'BLOCKED');
            assert.equal(state.stepsHistory.length, 1);
            assert.match(state.stepsHistory[0].observation, /\[BLOCKED\]/);
            assert.equal(caller.callCount, 0);
            assert.equal(telemetry?.gateDecisions[0]?.category, 'unknownCost');
        }

        // 4. Attempting to escape the VFS sandbox is blocked - the escape error
        //    surfaces as an observation, the loop keeps going, and the target
        //    file's real content never appears anywhere in history.
        {
            const secretPath = path.join(tmpRoot, '..', `vone-secret-${path.basename(tmpRoot)}.txt`);
            fs.writeFileSync(secretPath, 'top-secret-value');
            try {
                const caller = new ScriptedCaller([
                    `{"action":"tool","toolName":"read_file","arguments":{"path":"../${path.basename(secretPath)}"}}`,
                    '{"action":"finish","summary":"gave up after the sandbox refused the escape"}',
                ]);
                const router = new ModelRouter([freeRoute('escape-route')], createDefaultGates(), caller);
                const hub = new VOneUnifiedHubAgent(sandbox, router);
                const loop = new VOneAgentLoop(hub, hydration);

                const state = await loop.run('session-escape', 'try to read outside the sandbox');
                assert.equal(state.status, 'DONE');
                assert.match(state.stepsHistory[0].observation, /SECURITY VIOLATION/);
                assert.ok(!JSON.stringify(state.stepsHistory).includes('top-secret-value'));
            } finally {
                fs.rmSync(secretPath, { force: true });
            }
        }

        // 5. An unauthorized tool name is rejected before it ever reaches
        //    execution - proven with a spy hub so the call count is exact.
        {
            const spy = new SpyHub([
                '{"action":"tool","toolName":"delete_everything","arguments":{}}',
                '{"action":"finish","summary":"gave up after unauthorized tool"}',
            ]);
            const loop = new VOneAgentLoop(spy, hydration);

            const state = await loop.run('session-unauthorized', 'try a disallowed tool');
            assert.equal(state.status, 'DONE');
            assert.equal(spy.toolCalls.length, 0);
            assert.match(state.stepsHistory[0].observation, /\[UNAUTHORIZED TOOL\]/);
        }

        // 6. maxSteps caps a model that never says "finish" - INCOMPLETE, not
        //    an infinite loop.
        {
            const caller = new ScriptedCaller([
                '{"action":"tool","toolName":"read_file","arguments":{"path":"out.txt"}}',
            ]);
            const router = new ModelRouter([freeRoute('cap-route')], createDefaultGates(), caller);
            const hub = new VOneUnifiedHubAgent(sandbox, router);
            let telemetry: RunTelemetry | undefined;
            const loop = new VOneAgentLoop(hub, hydration, { maxSteps: 3, onTelemetry: (event) => (telemetry = event) });

            const state = await loop.run('session-cap', 'read forever');
            assert.equal(state.status, 'INCOMPLETE');
            assert.equal(state.stepsHistory.length, 3);
            assert.equal(caller.callCount, 3);
            assert.equal(telemetry?.errorClass, 'MaxStepsExceeded');
        }

        // 7. Two consecutive unparseable responses => FAILED, controlled, not
        //    an infinite retry.
        {
            const caller = new ScriptedCaller(['this is not json']);
            const router = new ModelRouter([freeRoute('parse-fail-route')], createDefaultGates(), caller);
            const hub = new VOneUnifiedHubAgent(sandbox, router);
            let telemetry: RunTelemetry | undefined;
            const loop = new VOneAgentLoop(hub, hydration, {
                maxConsecutiveParseFailures: 2,
                onTelemetry: (event) => (telemetry = event),
            });

            const state = await loop.run('session-parse-fail', 'do something');
            assert.equal(state.status, 'FAILED');
            assert.equal(state.stepsHistory.length, 2);
            assert.equal(caller.callCount, 2);
            assert.equal(telemetry?.errorClass, 'ParseError');
        }

        // 8. Resuming an INCOMPLETE session continues from the checkpoint - it
        //    never re-decides or re-executes the steps already recorded - and
        //    9. the artifacts/evidence ledger from the first run survives the
        //    resume untouched.
        {
            const caller1 = new ScriptedCaller([
                '{"action":"tool","toolName":"write_file","arguments":{"path":"evidence.txt","content":"artifact-content"}}',
                '{"action":"tool","toolName":"read_file","arguments":{"path":"evidence.txt"}}',
            ]);
            const router1 = new ModelRouter([freeRoute('evidence-route-1')], createDefaultGates(), caller1);
            const hub1 = new VOneUnifiedHubAgent(sandbox, router1);
            const loop1 = new VOneAgentLoop(hub1, hydration, { maxSteps: 2 });

            const state1 = await loop1.run('session-evidence', 'write and preserve evidence');
            assert.equal(state1.status, 'INCOMPLETE');
            assert.equal(state1.artifacts.length, 1);
            const expectedHash = sha256('artifact-content');
            assert.equal(state1.artifacts[0].path, 'evidence.txt');
            assert.equal(state1.artifacts[0].sha256, expectedHash);
            const stepsBeforeResume = JSON.stringify(state1.stepsHistory);

            const caller2 = new ScriptedCaller(['{"action":"finish","summary":"confirmed evidence"}']);
            const router2 = new ModelRouter([freeRoute('evidence-route-2')], createDefaultGates(), caller2);
            const hub2 = new VOneUnifiedHubAgent(sandbox, router2);
            const loop2 = new VOneAgentLoop(hub2, hydration, { maxSteps: 5 });

            const state2 = await loop2.run('session-evidence', 'write and preserve evidence');
            assert.equal(state2.status, 'DONE');
            assert.equal(caller2.callCount, 1); // only the new step asked the model - old ones were not redone
            assert.equal(state2.stepsHistory.length, 3); // 2 preserved + 1 new
            assert.equal(JSON.stringify(state2.stepsHistory.slice(0, 2)), stepsBeforeResume);
            assert.equal(state2.artifacts.length, 1); // unchanged - no duplicate, no loss
            assert.deepEqual(state2.artifacts[0], state1.artifacts[0]);
        }

        // 10. An idempotency key (explicit or auto-derived from toolName+arguments)
        //     prevents the same side-effecting action from executing twice, even
        //     if the model decides it again - proven with a spy hub so the
        //     underlying tool call count is exact.
        {
            const decision = '{"action":"tool","toolName":"write_file","arguments":{"path":"dup.txt","content":"same-content"}}';
            const spy = new SpyHub([decision, decision, '{"action":"finish","summary":"done"}']);
            const loop = new VOneAgentLoop(spy, hydration);

            const state = await loop.run('session-idempotent', 'write once, decide twice');
            assert.equal(state.status, 'DONE');
            assert.equal(spy.modelCalls, 3); // the model is still asked every iteration
            assert.equal(spy.toolCalls.length, 1); // but the duplicate decision never re-executes
            assert.equal(state.stepsHistory.length, 3);
            assert.match(state.stepsHistory[1].observation, /\[IDEMPOTENT REPLAY\]/);
        }

        // 11. Secrets are redacted before they're persisted to the checkpoint or
        //     fed back into the next prompt (best-effort - see vone_secret_redaction.ts).
        {
            const caller = new ScriptedCaller([
                '{"action":"tool","toolName":"write_file","arguments":{"path":"creds.txt","content":"api_key: \\"abcdefgh12345678\\""}}',
                '{"action":"tool","toolName":"read_file","arguments":{"path":"creds.txt"}}',
                '{"action":"finish","summary":"checked secret handling"}',
            ]);
            const router = new ModelRouter([freeRoute('redaction-route')], createDefaultGates(), caller);
            const hub = new VOneUnifiedHubAgent(sandbox, router);
            const loop = new VOneAgentLoop(hub, hydration);

            const state = await loop.run('session-redaction', 'write and read back a secret-looking value');
            assert.equal(state.status, 'DONE');
            const readStep = state.stepsHistory[1];
            assert.equal(readStep.observation, '[REDACTED]');
            assert.ok(!JSON.stringify(state.stepsHistory).includes('abcdefgh12345678'));
        }

        console.log('vone_agent_loop: all assertions passed');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
