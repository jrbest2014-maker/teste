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

type WorkerIdentityResolution = {
    token: string;
    source: 'IDENTITY_FILE' | 'IDENTITY_BOOTSTRAP';
    generation: number | null;
    tokenFile: string;
};

async function resolveWorkerIdentityToken(
    masterUrl: string,
    workerId: string,
    legacySeedToken?: string,
): Promise<WorkerIdentityResolution> {
    const tokenFile = path.resolve(
        process.env.VONE_WORKER_IDENTITY_TOKEN_FILE?.trim()
        || path.join(os.homedir(), '.vone', 'secrets', 'worker-identity-r1.token'),
    );

    if (fs.existsSync(tokenFile)) {
        const persisted = fs.readFileSync(tokenFile, 'utf8').trim();
        if (persisted.length < 32) throw new Error('VONE_WORKER_IDENTITY_TOKEN_FILE_invalid');
        return { token: persisted, source: 'IDENTITY_FILE', generation: null, tokenFile };
    }

    if (!legacySeedToken) throw new Error('VONE_WORKER_TOKEN_required_for_identity_bootstrap');

    const response = await fetch(new URL('/api/worker/identity/bootstrap', masterUrl), {
        method: 'POST',
        headers: {
            authorization: `Bearer ${legacySeedToken}`,
            'content-type': 'application/json',
        },
        body: JSON.stringify({ workerId }),
    });
    const body = await response.json().catch(() => ({})) as {
        ok?: boolean;
        token?: string;
        generation?: number;
        error?: string;
    };

    if (!response.ok || body.ok !== true || typeof body.token !== 'string' || body.token.length < 32) {
        throw new Error(`VONE_WORKER_IDENTITY_BOOTSTRAP_FAILED:${response.status}:${body.error || 'unknown'}`);
    }

    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    const tempFile = `${tokenFile}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, body.token, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempFile, tokenFile);

    return {
        token: body.token,
        source: 'IDENTITY_BOOTSTRAP',
        generation: Number(body.generation || 0) || null,
        tokenFile,
    };
}

async function probeOllama(ollamaUrl: string): Promise<Readonly<Record<string, unknown>>> {
    try {
        const response = await fetch(new URL('/api/version', ollamaUrl), {
            signal: AbortSignal.timeout(3_000),
        });
        if (!response.ok) return { ollama_health: 'OFFLINE', ollama_http_status: response.status };
        const body = await response.json().catch(() => ({})) as { version?: string };
        return {
            ollama_health: 'ONLINE',
            ollama_http_status: response.status,
            ollama_version: typeof body.version === 'string' ? body.version : null,
        };
    } catch {
        return { ollama_health: 'OFFLINE', ollama_http_status: null };
    }
}

async function main(): Promise<void> {
    const masterUrl = process.env.VONE_MASTER_URL?.trim() || 'https://vone-control-plane.vone-technology.workers.dev';
    const workerId = process.env.VONE_WORKER_ID?.trim() || 'DESKTOP_445339E_VONE_EXECUTOR_01';
    const legacySeedToken = process.env.VONE_WORKER_TOKEN?.trim();
    const projectRoot = path.resolve(process.env.VONE_PROJECT_ROOT?.trim() || process.cwd());
    const model = process.env.VONE_OLLAMA_MODEL?.trim() || 'v-one-coder:fast';
    const ollamaUrl = process.env.VONE_OLLAMA_URL?.trim() || 'http://127.0.0.1:11434';
    const identity = await resolveWorkerIdentityToken(masterUrl, workerId, legacySeedToken);
    const workerToken = identity.token;

    if (!fs.existsSync(projectRoot)) throw new Error('VONE_PROJECT_ROOT_not_found');

    const sandbox = new VOneVFSSandbox(projectRoot);
    // One checkpoint per session, outside the project root the agent writes in: a re-delivered
    // job finds its own DONE checkpoint and replays instead of re-executing.
    const stateRoot = resolveExecutorStateRoot(projectRoot, workerId, process.env.VONE_STATE_ROOT, os.homedir());
    fs.mkdirSync(stateRoot, { recursive: true });
    const hydration = new VOneSessionHydrationEngine(new VOneVFSSandbox(stateRoot), 'sessions');
    const gates = createDefaultGates();
    const ollamaCaller = new OllamaModelCaller({ baseUrl: ollamaUrl });
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
    const localBackend = new OllamaInferenceBackend(ollamaUrl, model);
    const inferenceExecutor = new VOneInferenceFailoverExecutor(budgetRouter, cloudBackend, localBackend);

    const worker = new VOneDualWorker({
        workerId,
        master,
        inferenceExecutor,
        hubChat: async (prompt,maxTokens) => {
            const router=new ModelRouter([{id:'vone-hub-local',tier:'free',model,costPerMTokUsd:0,state:'FREE_AVAILABLE',neuronsUsedToday:0}],gates,ollamaCaller);
            const hub=new VOneUnifiedHubAgent(sandbox,router);
            const out=await hub.askModel({prompt,maxTokens});
            return {text:out.text,model:out.model,routeId:out.routeId};
        },
        heartbeatDetails: async () => ({
            backend: 'cloudflare+ollama',
            provider: 'v-one',
            model,
            ollama_url: ollamaUrl,
            route_source: 'VONE_MASTER_CAPACITY_AND_BUDGET',
            cloud_auth_configured: Boolean(process.env.VONE_INFERENCE_TOKEN?.trim()),
            ...(await probeOllama(ollamaUrl)),
        }),
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

    try {
        await worker.heartbeat();
    } catch (error) {
        console.error('HEARTBEAT_START_ERROR', error instanceof Error ? error.message : String(error));
    }
    setInterval(() => worker.heartbeat().catch((error) => {
        console.error('HEARTBEAT_ERROR', error instanceof Error ? error.message : String(error));
    }), 10_000).unref();

    console.log(JSON.stringify({
        service: 'V-ONE Owned Executor Worker',
        protocol: 'VONE_EXECUTION_CONTRACT_R1',
        capacity_protocol: 'VONE_CAPACITY_SNAPSHOT_R1',
        capacity_authority: 'VONE_MASTER',
        workerId,
        provider: 'ollama',
        model,
        ollamaUrl,
        projectRoot,
        stateRoot,
        gates,
    }));

    while (true) {
        try {
            const state = await worker.runOnce();
            if (state !== 'IDLE') console.log('WORKER_CYCLE', state);
        } catch (error) {
            console.error('WORKER_LOOP_ERROR', error instanceof Error ? error.message : String(error));
        }
        await sleep(10_000);
    }
}

main().catch((error) => {
    console.error('FATAL', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
