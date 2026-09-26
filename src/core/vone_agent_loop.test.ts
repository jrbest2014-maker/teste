import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VOneVFSSandbox } from './vone_vfs_sandbox';
import { VOneHydrationEngine } from './vone_hydration_engine';
import { VOneUnifiedHubAgent } from './vone_unified_hub_agent';
import { VOneAgentLoop } from './vone_agent_loop';
import {
    ModelRouter,
    createDefaultGates,
    type InferenceRequest,
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

async function main(): Promise<void> {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vone-agent-loop-'));
    try {
        const sandbox = new VOneVFSSandbox(tmpRoot);
        const hydration = new VOneHydrationEngine(sandbox);

        // Happy path: write, then read, then finish - three recorded steps, DONE.
        {
            const caller = new ScriptedCaller([
                '{"action":"tool","toolName":"write_file","arguments":{"path":"out.txt","content":"hi"}}',
                '{"action":"tool","toolName":"read_file","arguments":{"path":"out.txt"}}',
                '{"action":"finish","summary":"wrote and read out.txt"}',
            ]);
            const router = new ModelRouter([freeRoute()], createDefaultGates(), caller);
            const hub = new VOneUnifiedHubAgent(sandbox, router);
            const loop = new VOneAgentLoop(hub, hydration);

            const state = await loop.run('session-happy', 'write and read out.txt');
            assert.equal(state.status, 'DONE');
            assert.equal(state.stepsHistory.length, 3);
            assert.equal(state.stepsHistory[1].observation, 'hi');
            assert.equal(caller.callCount, 3);

            // Resuming a DONE session returns immediately - no model call, no new steps.
            const resumed = await loop.run('session-happy', 'write and read out.txt');
            assert.equal(resumed.status, 'DONE');
            assert.equal(resumed.stepsHistory.length, 3);
            assert.equal(caller.callCount, 3);
        }

        // Unparseable model output twice in a row -> FAILED, loop stops rather than spinning forever.
        {
            const caller = new ScriptedCaller(['this is not json']);
            const router = new ModelRouter([freeRoute()], createDefaultGates(), caller);
            const hub = new VOneUnifiedHubAgent(sandbox, router);
            const loop = new VOneAgentLoop(hub, hydration, { maxConsecutiveParseFailures: 2 });

            const state = await loop.run('session-parse-fail', 'do something');
            assert.equal(state.status, 'FAILED');
            assert.equal(state.stepsHistory.length, 2);
            assert.equal(caller.callCount, 2);
        }

        // A model that never says "finish" is stopped at maxSteps, not left to run forever.
        {
            const caller = new ScriptedCaller([
                '{"action":"tool","toolName":"read_file","arguments":{"path":"out.txt"}}',
            ]);
            const router = new ModelRouter([freeRoute()], createDefaultGates(), caller);
            const hub = new VOneUnifiedHubAgent(sandbox, router);
            const loop = new VOneAgentLoop(hub, hydration, { maxSteps: 3 });

            const state = await loop.run('session-cap', 'read forever');
            assert.equal(state.status, 'INCOMPLETE');
            assert.equal(state.stepsHistory.length, 3);
            assert.equal(caller.callCount, 3);
        }

        // A route with unknown cost blocks routing before the caller is ever invoked -
        // the loop must record BLOCKED and stop, never treat this as a retryable error.
        {
            const unknownCostRoute: ModelRoute = { ...freeRoute('unknown-cost-route'), costPerMTokUsd: null };
            const caller = new ScriptedCaller(['{"action":"finish","summary":"unreachable"}']);
            const router = new ModelRouter([unknownCostRoute], createDefaultGates(), caller);
            const hub = new VOneUnifiedHubAgent(sandbox, router);
            const loop = new VOneAgentLoop(hub, hydration);

            const state = await loop.run('session-blocked', 'do something costly');
            assert.equal(state.status, 'BLOCKED');
            assert.equal(state.stepsHistory.length, 1);
            assert.match(state.stepsHistory[0].observation, /\[BLOCKED\]/);
            assert.equal(caller.callCount, 0);
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
