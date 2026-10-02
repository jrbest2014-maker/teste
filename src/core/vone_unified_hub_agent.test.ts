import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VOneVFSSandbox } from './vone_vfs_sandbox';
import { VOneUnifiedHubAgent } from './vone_unified_hub_agent';
import {
    ModelRouter,
    RoutingBlockedError,
    createDefaultGates,
    createDefaultRoutes,
    type InferenceRequest,
    type ModelCaller,
    type ModelRoute,
} from '../server/vone_model_router';

class StubCaller implements ModelCaller {
    public calls: Array<{ route: ModelRoute; request: InferenceRequest }> = [];
    constructor(private readonly neuronsUsed = 10) {}

    public async run(route: ModelRoute, request: InferenceRequest) {
        this.calls.push({ route, request });
        return { text: `stub-response-from-${route.id}`, neuronsUsed: this.neuronsUsed };
    }
}

async function main(): Promise<void> {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vone-hub-'));
    try {
        const sandbox = new VOneVFSSandbox(tmpRoot);

        // File tool orchestration is unaffected by adding the model router.
        {
            const hub = new VOneUnifiedHubAgent(sandbox);
            const writeResult = await hub.orchestrateExternalTool('write_file', {
                toolName: 'write_file',
                arguments: { path: 'note.txt', content: 'hello' },
            });
            assert.equal(writeResult, '[SUCCESS]');
            const readResult = await hub.orchestrateExternalTool('read_file', {
                toolName: 'read_file',
                arguments: { path: 'note.txt' },
            });
            assert.equal(readResult, 'hello');
        }

        // Without a configured router, askModel refuses instead of silently no-op-ing.
        {
            const hub = new VOneUnifiedHubAgent(sandbox);
            await assert.rejects(() => hub.askModel({ prompt: 'hi' }), /No ModelRouter configured/);
        }

        // With a router wired in, the hub delegates and returns the routed result.
        {
            const caller = new StubCaller(10);
            const router = new ModelRouter(createDefaultRoutes(), createDefaultGates(), caller);
            const hub = new VOneUnifiedHubAgent(sandbox, router);
            const result = await hub.askModel({ prompt: 'hello' });
            assert.equal(result.routeId, 'cloudflare-free-llama');
            assert.equal(caller.calls.length, 1);
        }

        // The hub inherits the router's gates - a physical-output request never
        // reaches the model caller, it's refused at askModel.
        {
            const caller = new StubCaller(10);
            const router = new ModelRouter(createDefaultRoutes(), createDefaultGates(), caller);
            const hub = new VOneUnifiedHubAgent(sandbox, router);
            await assert.rejects(
                () => hub.askModel({ prompt: 'send gcode', requiresPhysicalOutput: true }),
                RoutingBlockedError,
            );
            assert.equal(caller.calls.length, 0);
        }

        console.log('vone_unified_hub_agent: all assertions passed');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
