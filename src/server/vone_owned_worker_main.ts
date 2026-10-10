import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VOneVFSSandbox } from '../core/vone_vfs_sandbox';
import { VOneSessionHydrationEngine, resolveExecutorStateRoot } from '../core/vone_session_hydration_engine';
import { VOneUnifiedHubAgent } from '../core/vone_unified_hub_agent';
import { VOneExecutor } from './vone_executor';
import { ModelRouter, createDefaultGates } from './vone_model_router';
import { OllamaModelCaller } from './vone_ollama_caller';
import { VOneMasterWorkerHttpClient } from './vone_master_worker_client';
import { VOneDualWorker } from './vone_dual_worker';
import { VOneInferenceFailoverExecutor } from './vone_inference_failover_executor';
import { BudgetedInferenceRouter } from './vone_budgeted_inference_router';
import { NeuronBudgetManager } from './vone_neuron_budget';
import { CloudflareInferenceBackend, OllamaInferenceBackend } from './vone_inference_backends';
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

function positiveIntFromEnv(name: string, fallbackMs: number): number {
    const raw = Number(process.env[name]?.trim());
    return Number.isFinite(raw) && raw > 0 ? raw : fallbackMs;
}

async function main(): Promise<void> {
    const masterUrl = process.env.VONE_MASTER_URL?.trim() || 'https://vone-control-plane.vone-technology.workers.dev';
    // _01 is retired: the Master has an IDENTITY_R1 record (generation 2) registered
    // for it with no recoverable token (per-worker tokens are shown once, at issuance/
    // rotation, and never stored in plaintext - see AGENTS.md, "O Master"). Once a
    // workerId has an identity record, the Master's authorizeWorkerRequest() denies it
    // outright instead of falling back to the legacy shared secret, so VONE_WORKER_TOKEN
    // (the shared secret) can never satisfy it again. _02 has no identity record, so it
    // authenticates via the legacy path - confirmed against the live Master 2026-10-10.
    const workerId = process.env.VONE_WORKER_ID?.trim() || 'DESKTOP_445339E_VONE_EXECUTOR_02';
    const workerToken = required('VONE_WORKER_TOKEN');
    const projectRoot = path.resolve(process.env.VONE_PROJECT_ROOT?.trim() || process.cwd());
    const model = process.env.VONE_OLLAMA_MODEL?.trim() || 'v-one-coder:fast';

    if (!fs.existsSync(projectRoot)) throw new Error('VONE_PROJECT_ROOT_not_found');

    const sandbox = new VOneVFSSandbox(projectRoot);
    // One checkpoint per session, outside the project root the agent writes in: a re-delivered
    // job finds its own DONE checkpoint and replays instead of re-executing.
    const stateRoot = resolveExecutorStateRoot(projectRoot, workerId, process.env.VONE_STATE_ROOT, os.homedir());
    fs.mkdirSync(stateRoot, { recursive: true });
    const hydration = new VOneSessionHydrationEngine(new VOneVFSSandbox(stateRoot), 'sessions');
    const gates = createDefaultGates();
    const ollamaCaller = new OllamaModelCaller();
    const master = new VOneMasterWorkerHttpClient({ baseUrl: masterUrl, workerId, workerToken });

    const capacityValidation = {
        expectedProviderContains: 'ollama',
        preferredModel: model,
        maxSnapshotAgeMs: 120_000,
    } as const;

    const neuronBudget = new NeuronBudgetManager(10_000, 500);
    const budgetRouter = new BudgetedInferenceRouter(neuronBudget);
    const cloudEndpoint = process.env.VONE_CLOUD_INFERENCE_URL?.trim() || 'https://v-one-cloud-inference-r1.vone-technology.workers.dev/infer';
    const cloudBackend = new CloudflareInferenceBackend(cloudEndpoint, process.env.VONE_INFERENCE_TOKEN?.trim());
    const localBackend = new OllamaInferenceBackend('http://127.0.0.1:11434', model);
    const inferenceExecutor = new VOneInferenceFailoverExecutor(budgetRouter, cloudBackend, localBackend);

    const worker = new VOneDualWorker({
        workerId,
        master,
        inferenceExecutor,
        heartbeatDetails: {
            backend: 'cloudflare+ollama',
            provider: 'v-one',
            model,
            route_source: 'VONE_MASTER_CAPACITY_AND_BUDGET',
            cloud_auth_configured: Boolean(process.env.VONE_INFERENCE_TOKEN?.trim()),
        },
        ownedExecutor: {
            capacityValidation,
            executorFactory: async (request) => {
                const snapshot = request.capacity_snapshot;
                assertVerifiedCapacitySnapshot(snapshot, capacityValidation);
                const route = modelRouteFromCapacitySnapshot(snapshot, model);
                const router = new ModelRouter([route], gates, ollamaCaller);
                const hub = new VOneUnifiedHubAgent(sandbox, router);
                return new VOneExecutor(hub, hydration);
            },
        },
    });

    // Intervalos conservadores por padrão: a cada 5s de heartbeat + 1.5s de
    // poll, dois workers (01 e 02, ambos ativos em produção - ver AGENTS.md)
    // somam ~150 mil requisições/dia pro Master, cada uma plausivelmente
    // gravando no D1 (last_seen do heartbeat, job claim do poll). O D1
    // free tier tem teto diário de escrita - confirmado ao vivo em
    // 2026-10-10 (D1_ERROR: daily row write limit excedido, Master preso
    // em HOLD/OFFLINE no meio do dia). Isso não desafoga a cota já gasta
    // hoje (só reseta à meia-noite UTC), mas reduz a pressão futura.
    // Configurável via env pra quem precisar de latência mais baixa.
    const heartbeatIntervalMs = positiveIntFromEnv('VONE_HEARTBEAT_INTERVAL_MS', 30_000);
    const pollIntervalMs = positiveIntFromEnv('VONE_POLL_INTERVAL_MS', 5_000);

    await worker.heartbeat();
    setInterval(() => worker.heartbeat().catch((error) => {
        console.error('HEARTBEAT_ERROR', error instanceof Error ? error.message : String(error));
    }), heartbeatIntervalMs).unref();

    console.log(JSON.stringify({
        service: 'V-ONE Owned Executor Worker',
        protocol: 'VONE_EXECUTION_CONTRACT_R1',
        capacity_protocol: 'VONE_CAPACITY_SNAPSHOT_R1',
        capacity_authority: 'VONE_MASTER',
        workerId,
        provider: 'ollama',
        model,
        projectRoot,
        stateRoot,
        gates,
        heartbeatIntervalMs,
        pollIntervalMs,
    }));

    while (true) {
        try {
            const state = await worker.runOnce();
            if (state !== 'IDLE') console.log('WORKER_CYCLE', state);
        } catch (error) {
            console.error('WORKER_LOOP_ERROR', error instanceof Error ? error.message : String(error));
        }
        await sleep(pollIntervalMs);
    }
}

main().catch((error) => {
    console.error('FATAL', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
