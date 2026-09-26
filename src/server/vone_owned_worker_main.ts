import fs from 'node:fs';
import path from 'node:path';
import { VOneVFSSandbox } from '../core/vone_vfs_sandbox';
import { VOneHydrationEngine } from '../core/vone_hydration_engine';
import { VOneUnifiedHubAgent } from '../core/vone_unified_hub_agent';
import { VOneExecutor } from './vone_executor';
import { ModelRouter, createDefaultGates } from './vone_model_router';
import { OllamaModelCaller } from './vone_ollama_caller';
import { VOneMasterWorkerHttpClient } from './vone_master_worker_client';
import { VOneOwnedExecutorWorker } from './vone_owned_executor_worker';
import {
    assertVerifiedCapacitySnapshot,
    modelRouteFromCapacitySnapshot,
} from './vone_capacity_snapshot';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function required(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name}_required`);
    return value;
}

async function main(): Promise<void> {
    const masterUrl = process.env.VONE_MASTER_URL?.trim() || 'https://vone-control-plane.vone-technology.workers.dev';
    const workerId = process.env.VONE_WORKER_ID?.trim() || 'DESKTOP_445339E_VONE_EXECUTOR_01';
    const workerToken = required('VONE_WORKER_TOKEN');
    const projectRoot = path.resolve(process.env.VONE_PROJECT_ROOT?.trim() || process.cwd());
    const model = process.env.VONE_OLLAMA_MODEL?.trim() || 'v-one-coder:fast';

    if (!fs.existsSync(projectRoot)) throw new Error('VONE_PROJECT_ROOT_not_found');

    const sandbox = new VOneVFSSandbox(projectRoot);
    const hydration = new VOneHydrationEngine(sandbox);
    const gates = createDefaultGates();
    const ollamaCaller = new OllamaModelCaller();
    const master = new VOneMasterWorkerHttpClient({ baseUrl: masterUrl, workerId, workerToken });

    const capacityValidation = {
        expectedProviderContains: 'ollama',
        preferredModel: model,
        maxSnapshotAgeMs: 120_000,
    } as const;

    const worker = new VOneOwnedExecutorWorker({
        workerId,
        master,
        heartbeatDetails: {
            backend: 'ollama',
            provider: 'ollama',
            model,
            route_source: 'VONE_MASTER_CAPACITY_SNAPSHOT_ONLY',
        },
        capacityValidation,
        executorFactory: async (request) => {
            const snapshot = request.capacity_snapshot;
            assertVerifiedCapacitySnapshot(snapshot, capacityValidation);
            const route = modelRouteFromCapacitySnapshot(snapshot, model);
            const router = new ModelRouter([route], gates, ollamaCaller);
            const hub = new VOneUnifiedHubAgent(sandbox, router);
            return new VOneExecutor(hub, hydration);
        },
    });

    await worker.heartbeat();
    setInterval(() => worker.heartbeat().catch((error) => {
        console.error('HEARTBEAT_ERROR', error instanceof Error ? error.message : String(error));
    }), 5_000).unref();

    console.log(JSON.stringify({
        service: 'V-ONE Owned Executor Worker',
        protocol: 'VONE_EXECUTION_CONTRACT_R1',
        capacity_protocol: 'VONE_CAPACITY_SNAPSHOT_R1',
        capacity_authority: 'VONE_MASTER',
        workerId,
        provider: 'ollama',
        model,
        projectRoot,
        gates,
    }));

    while (true) {
        try {
            const state = await worker.runOnce();
            if (state !== 'IDLE') console.log('WORKER_CYCLE', state);
        } catch (error) {
            console.error('WORKER_LOOP_ERROR', error instanceof Error ? error.message : String(error));
        }
        await sleep(1_500);
    }
}

main().catch((error) => {
    console.error('FATAL', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
