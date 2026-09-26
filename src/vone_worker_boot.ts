import { createWorkerFromEnv } from './server/vone_worker_factory';
import { WorkerConfigError, describeWorkerConfig } from './server/vone_worker_config';

/**
 * Entry point for the Master-connected executor worker
 * (VONE_EXECUTION_CONTRACT_R1, executor side). Separate from vone_boot.ts,
 * which is left untouched. All configuration comes from environment
 * variables (see vone_worker_config.ts); only a presence/absence view of
 * credentials is ever printed. NOTE: the HTTP wire format is a proposal and
 * has not been verified against the real Master.
 */
async function main(): Promise<void> {
    let composed;
    try {
        composed = createWorkerFromEnv(process.env);
    } catch (error) {
        if (error instanceof WorkerConfigError) {
            console.error(error.message);
            process.exitCode = 78; // EX_CONFIG
            return;
        }
        throw error;
    }

    console.log(JSON.stringify({ event: 'worker.boot', ...describeWorkerConfig(composed.config) }));

    const abort = new AbortController();
    process.once('SIGINT', () => abort.abort());
    process.once('SIGTERM', () => abort.abort());

    const outcomes = await composed.worker.run({ signal: abort.signal, idleDelayMs: composed.config.pollIntervalMs });
    const last = outcomes[outcomes.length - 1];
    if (last?.kind === 'auth_rejected') process.exitCode = 77; // EX_NOPERM
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
