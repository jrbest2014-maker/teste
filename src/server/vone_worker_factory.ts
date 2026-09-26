import fs from 'node:fs';
import path from 'node:path';
import { VOneVFSSandbox } from '../core/vone_vfs_sandbox';
import { VOneSessionHydrationEngine } from '../core/vone_session_hydration_engine';
import { VOneUnifiedHubAgent } from '../core/vone_unified_hub_agent';
import { VOneExecutor, type ExecutorOptions } from './vone_executor';
import {
    CloudflareWorkersAICaller,
    ModelRouter,
    createDefaultGates,
    createDefaultRoutes,
    type ModelCaller,
    type ModelRoute,
} from './vone_model_router';
import type { MasterTransport } from './vone_execution_contract';
import { HttpMasterTransport } from './vone_http_master_transport';
import { OllamaCaller } from './vone_ollama_caller';
import { SandboxResultLedger, VOneMasterWorker, type SubmitRetryPolicy, type WorkerLogEvent } from './vone_master_worker';
import { WorkerConfigError, loadWorkerConfig, type WorkerConfig } from './vone_worker_config';

export interface WorkerDependencies {
    /** Override the model caller (tests use a deterministic ScriptedCaller). */
    readonly caller?: ModelCaller;
    /** Override the Master transport (tests use an in-process mock). */
    readonly transport?: MasterTransport;
    readonly fetchImpl?: typeof fetch;
    readonly routes?: ModelRoute[];
    readonly executorOptions?: ExecutorOptions;
    readonly submitRetry?: SubmitRetryPolicy;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly now?: () => number;
    readonly log?: (event: WorkerLogEvent) => void;
}

export interface ComposedWorker {
    readonly config: WorkerConfig;
    readonly worker: VOneMasterWorker;
    readonly router: ModelRouter;
    readonly executor: VOneExecutor;
    /** Where jobs run (agent tools are confined here). */
    readonly sandbox: VOneVFSSandbox;
    /** Worker root holding the ledger - outside the job sandbox, so no job can rewrite it. */
    readonly workerSandbox: VOneVFSSandbox;
}

/**
 * Wires Master -> worker -> {VOneExecutor -> VOneAgentLoop, ModelRouter}.
 * Layout under VONE_WORKER_ROOT (default cwd): the ledger lives at the root,
 * per-session checkpoints in `<root>/sessions`, and jobs run in
 * `<root>/workspace` - a separate VOneVFSSandbox, so agent tools (write_file
 * etc.) cannot reach or rewrite the ledger or any session's checkpoint.
 * Gates always come from createDefaultGates() and the very same object is
 * handed to both the router and the worker - there is no configuration
 * path (env or job) that loosens them.
 */
export function createWorkerFromConfig(config: WorkerConfig, deps: WorkerDependencies = {}): ComposedWorker {
    let caller = deps.caller;
    if (!caller) {
        if (config.modelRoute === 'ollama' && config.ollama) {
            caller = new OllamaCaller({ baseUrl: config.ollama.baseUrl, timeoutMs: config.ollama.timeoutMs, fetchImpl: deps.fetchImpl });
        } else if (config.modelRoute === 'cloudflare' && config.cloudflareAi) {
            caller = new CloudflareWorkersAICaller({
                accountId: config.cloudflareAi.accountId,
                apiToken: config.cloudflareAi.credential.reveal(),
                fetchImpl: deps.fetchImpl,
            });
        } else {
            throw new WorkerConfigError(
                ['VONE_MODEL_ROUTE'],
                'no model route configured; set VONE_OLLAMA_MODEL for the local route or VONE_CF_ACCOUNT_ID + VONE_CF_AI_TOKEN for Workers AI',
            );
        }
    }

    const gates = createDefaultGates();
    const workerSandbox = new VOneVFSSandbox(config.workRoot ?? undefined);
    const jobsRoot = path.join(workerSandbox.getProjectRoot(), 'workspace');
    fs.mkdirSync(jobsRoot, { recursive: true });
    const sandbox = new VOneVFSSandbox(jobsRoot);
    const hydration = new VOneSessionHydrationEngine(workerSandbox, 'sessions');
    const router = new ModelRouter(deps.routes ?? routesFor(config), gates, caller);
    const hub = new VOneUnifiedHubAgent(sandbox, router);
    const executor = new VOneExecutor(hub, hydration, deps.executorOptions);

    const transport =
        deps.transport ??
        new HttpMasterTransport({
            baseUrl: config.masterUrl,
            credential: config.credential,
            timeoutMs: config.requestTimeoutMs,
            fetchImpl: deps.fetchImpl,
        });

    const worker = new VOneMasterWorker({
        workerId: config.workerId,
        transport,
        executor,
        inference: router,
        gates,
        ledger: new SandboxResultLedger(workerSandbox),
        submitRetry: deps.submitRetry,
        sleep: deps.sleep,
        now: deps.now,
        log: deps.log,
    });

    return { config, worker, router, executor, sandbox, workerSandbox };
}

/**
 * Only the configured backend's free route plus the paid fallback, which
 * PAID_BLOCKED=INVIOLABLE keeps unselectable. There is never a second free
 * route to spill onto, so a failing backend fails the job instead of
 * silently switching providers.
 */
function routesFor(config: WorkerConfig): ModelRoute[] {
    const [cloudflareFree, paidFallback] = createDefaultRoutes();
    if (config.modelRoute === 'ollama' && config.ollama) {
        const local: ModelRoute = {
            id: 'ollama-local',
            tier: 'free',
            model: config.ollama.model,
            costPerMTokUsd: 0,
            state: 'FREE_AVAILABLE',
            neuronsUsedToday: 0,
        };
        return [local, paidFallback];
    }
    return [cloudflareFree, paidFallback];
}

/** loadWorkerConfig() runs first, so a missing token throws before anything touches the network. */
export function createWorkerFromEnv(env: NodeJS.ProcessEnv, deps: WorkerDependencies = {}): ComposedWorker {
    return createWorkerFromConfig(loadWorkerConfig(env), deps);
}
