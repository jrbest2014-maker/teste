import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VOneVFSSandbox } from '../core/vone_vfs_sandbox';
import { VOneHydrationEngine } from '../core/vone_hydration_engine';
import { VOneUnifiedHubAgent } from '../core/vone_unified_hub_agent';
import { VOneExecutor, type ExecutorRequest, type ExecutorResult } from './vone_executor';
import {
    ModelRouter,
    createDefaultGates,
    type InferenceRequest,
    type ModelCaller,
    type ModelRoute,
} from './vone_model_router';

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

function freeRoute(id = 'exec-free-route'): ModelRoute {
    return { id, tier: 'free', model: 'test-model', costPerMTokUsd: 0, state: 'FREE_AVAILABLE', neuronsUsedToday: 0 };
}

function paidRoute(id = 'exec-paid-route'): ModelRoute {
    return { id, tier: 'paid', model: 'paid-model', costPerMTokUsd: 5, state: 'FREE_AVAILABLE', neuronsUsedToday: 0 };
}

/**
 * Stands in for "Claude/ChatGPT as lightweight supervisor": delegates the
 * whole objective to the executor in one call and only validates the
 * evidence it gets back - it must never re-decide steps or call the model
 * itself, which is what the caller-count assertion below proves.
 */
async function lightSupervisorHandleTask(
    executor: VOneExecutor,
    request: ExecutorRequest,
): Promise<{ validated: boolean; result: ExecutorResult }> {
    const result = await executor.execute(request);
    const validated = result.state.status === 'DONE' && result.state.artifacts.length > 0;
    return { validated, result };
}

async function main(): Promise<void> {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vone-executor-'));
    try {
        const sandbox = new VOneVFSSandbox(tmpRoot);
        const hydration = new VOneHydrationEngine(sandbox);

        // Delegation chain: supervisor -> executor -> loop -> router -> route ->
        // execution -> validation -> evidence. The supervisor never touches
        // askModel/orchestrateExternalTool itself - it only reads the result.
        {
            const caller = new ScriptedCaller([
                '{"action":"tool","toolName":"write_file","arguments":{"path":"result.txt","content":"executor-output"}}',
                '{"action":"finish","summary":"done via executor"}',
            ]);
            const router = new ModelRouter([freeRoute()], createDefaultGates(), caller);
            const hub = new VOneUnifiedHubAgent(sandbox, router);
            const executor = new VOneExecutor(hub, hydration);

            const { validated, result } = await lightSupervisorHandleTask(executor, {
                sessionId: 'session-delegation',
                objective: 'produce evidence via the executor',
            });

            assert.equal(validated, true);
            assert.equal(result.state.status, 'DONE');
            assert.equal(result.state.artifacts.length, 1);
            assert.equal(result.state.artifacts[0].path, 'result.txt');
            assert.equal(result.telemetry.routeId, 'exec-free-route');
            assert.equal(result.telemetry.status, 'DONE');
            assert.equal(result.telemetry.errorClass, 'None');
            assert.equal(result.telemetry.stepCount, 2);
            assert.equal(caller.callCount, 2); // exactly the loop's own calls - the supervisor added none
        }

        // Gate propagation: the executor does not reimplement routing - a
        // paid-only route set is blocked exactly like at the router/loop
        // layer, before any model call, with no executor-side special case.
        {
            const caller = new ScriptedCaller(['{"action":"finish","summary":"unreachable"}']);
            const router = new ModelRouter([paidRoute()], createDefaultGates(), caller);
            const hub = new VOneUnifiedHubAgent(sandbox, router);
            const executor = new VOneExecutor(hub, hydration);

            const result = await executor.execute({ sessionId: 'session-exec-blocked', objective: 'spend money' });
            assert.equal(result.state.status, 'BLOCKED');
            assert.equal(result.telemetry.errorClass, 'RoutingBlocked');
            assert.equal(result.telemetry.gateDecisions[0]?.category, 'paidBlocked');
            assert.equal(caller.callCount, 0);
        }

        // Telemetry never carries prompt text, tool arguments, or raw
        // observations/summaries - only identifiers, counts, and outcomes.
        {
            const caller = new ScriptedCaller(['{"action":"finish","summary":"no payload leakage check"}']);
            const router = new ModelRouter([freeRoute('telemetry-route')], createDefaultGates(), caller);
            const hub = new VOneUnifiedHubAgent(sandbox, router);
            const executor = new VOneExecutor(hub, hydration);

            const result = await executor.execute({ sessionId: 'session-telemetry-shape', objective: 'x' });
            const telemetryKeys = Object.keys(result.telemetry);
            for (const forbidden of ['prompt', 'arguments', 'observation', 'decisionRaw', 'summary']) {
                assert.ok(!telemetryKeys.includes(forbidden), `telemetry must not carry a "${forbidden}" field`);
            }
        }

        console.log('vone_executor: all assertions passed');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
