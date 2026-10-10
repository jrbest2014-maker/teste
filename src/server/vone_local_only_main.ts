import { VOneInferenceFailoverExecutor } from './vone_inference_failover_executor';
import { BudgetedInferenceRouter } from './vone_budgeted_inference_router';
import { NeuronBudgetManager } from './vone_neuron_budget';
import { CloudflareInferenceBackend, OllamaInferenceBackend } from './vone_inference_backends';
import { VOneLocalChatServer } from './vone_local_chat_server';

/**
 * Entrypoint alternativo, deliberadamente sem o worker próprio
 * (vone_owned_worker_main.ts) inteiro. Existe pra quem não tem (ou
 * perdeu) o VONE_WORKER_TOKEN - esse token só serve pra autenticar
 * contra o Master na nuvem (heartbeat/fila de jobs); o chat local em si
 * (VOneLocalChatServer + VOneInferenceFailoverExecutor) nunca precisou
 * dele, só precisa do Ollama local (e, se configurado, do endpoint
 * público de inferência na nuvem como primeira tentativa).
 *
 * Sobe só isto: nenhuma conexão com o Master, nenhum heartbeat, nenhum
 * polling de job. Só o servidor HTTP local (loopback-only) que
 * apps/vone-studio (ou qualquer cliente na mesma máquina) já sabe
 * consumir via LocalVOneApiClient.
 */
function positiveIntFromEnv(name: string, fallbackMs: number): number {
    const raw = Number(process.env[name]?.trim());
    return Number.isFinite(raw) && raw > 0 ? raw : fallbackMs;
}

async function main(): Promise<void> {
    const model = process.env.VONE_OLLAMA_MODEL?.trim() || 'v-one-coder:fast';
    const neuronBudget = new NeuronBudgetManager(10_000, 500);
    const budgetRouter = new BudgetedInferenceRouter(neuronBudget);
    const cloudEndpoint =
        process.env.VONE_CLOUD_INFERENCE_URL?.trim() ||
        'https://v-one-cloud-inference-r1.vone-technology.workers.dev/infer';
    const cloudBackend = new CloudflareInferenceBackend(cloudEndpoint, process.env.VONE_INFERENCE_TOKEN?.trim());
    const localBackend = new OllamaInferenceBackend('http://127.0.0.1:11434', model);
    const inferenceExecutor = new VOneInferenceFailoverExecutor(budgetRouter, cloudBackend, localBackend);

    const localChatPort = positiveIntFromEnv('VONE_LOCAL_CHAT_PORT', 8787);
    const server = new VOneLocalChatServer(inferenceExecutor, { port: localChatPort });
    await server.start();

    console.log(JSON.stringify({
        service: 'V-ONE Local-Only Chat (sem Master, sem token de worker)',
        model,
        local_chat_server: {
            ...server.getAddress(),
            auth_token: server.getAuthToken(),
            note:
                'Não é credencial Cloudflare - token local gerado agora, só vale enquanto este processo roda. ' +
                'Copie host/porta/token pra VITE_VONE_LOCAL_URL/VITE_VONE_LOCAL_TOKEN em apps/vone-studio/.env.local.',
        },
    }));
    console.log('[START] Chat local no ar. Ctrl+C pra parar.');
}

main().catch((error) => {
    console.error('FATAL', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
