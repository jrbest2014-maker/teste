import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InferenceRequest, ModelCaller, ModelRoute } from './server/vone_model_router';
import { loadWorkerConfig } from './server/vone_worker_config';
import { createWorkerFromConfig } from './server/vone_worker_factory';
import { InProcessMasterTransport, MockMaster } from './server/testing/vone_mock_master';

/**
 * Runs the full executor-side chain end to end with no network and no cost:
 * mock Master -> claim -> worker -> VOneExecutor/VOneAgentLoop or
 * ModelRouter -> result -> Master ack. The model answers are scripted, so
 * this demonstrates the plumbing and the gates, not model quality, and it
 * says nothing about the real Master's wire format.
 */

const DEMO_TOKEN = 'DEMO-LOCAL-ONLY-not-a-secret';

class ScriptedCaller implements ModelCaller {
    public callCount = 0;
    constructor(private readonly responses: string[]) {}

    public async run(_route: ModelRoute, _request: InferenceRequest) {
        const text = this.responses[Math.min(this.callCount, this.responses.length - 1)];
        this.callCount += 1;
        return { text, neuronsUsed: 1 };
    }
}

async function main(): Promise<void> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vone-demo-'));
    try {
        const master = new MockMaster({ expectedToken: DEMO_TOKEN });
        const caller = new ScriptedCaller([
            '{"action":"tool","toolName":"write_file","arguments":{"path":"relatorio.txt","content":"relatorio gerado pelo agente"}}',
            '{"action":"finish","summary":"relatorio escrito"}',
            'Resposta de inferencia (roteirizada).',
        ]);
        const { worker } = createWorkerFromConfig(
            loadWorkerConfig({
                VONE_MASTER_URL: 'https://master.demo.invalid',
                VONE_WORKER_ID: 'demo-worker',
                VONE_WORKER_TOKEN: DEMO_TOKEN,
                VONE_WORKER_ROOT: root,
            }),
            {
                caller,
                routes: [{ id: 'free-demo', tier: 'free', model: 'demo-model', costPerMTokUsd: 0, state: 'FREE_AVAILABLE', neuronsUsedToday: 0 }],
                transport: new InProcessMasterTransport(master, DEMO_TOKEN),
                sleep: async () => {},
                log: () => {},
            },
        );

        const jobs = [
            { id: 'executor', toolName: 'vone_executor_execute', args: { session_id: 'demo-session', objective: 'escrever relatorio.txt' } },
            { id: 'inferencia', toolName: 'vone_inference_execute', args: { prompt: 'diga oi', max_tokens: 64 } },
            { id: 'saida-fisica', toolName: 'vone_inference_execute', args: { prompt: 'mover extrusora', requires_physical_output: true } },
            { id: 'tool-desconhecida', toolName: 'vone_rm_rf', args: {} },
        ];
        for (const job of jobs) master.enqueue({ id: `job-${job.id}`, toolName: job.toolName, args: job.args });

        console.log('SIMULACAO LOCAL: Master mock (fio VONE_WORKER_IDENTITY_R1) + respostas de modelo roteirizadas. Sem rede, sem custo.\n');
        const run = async (label: string) => {
            const before = caller.callCount;
            const outcome = await worker.runOnce();
            const detail =
                outcome.kind === 'completed'
                    ? `status=${outcome.status} veredito=${outcome.verdict} executou=${outcome.executed} replay=${outcome.replayed}`
                    : outcome.kind;
            console.log(`${label.padEnd(28)} ${detail}  chamadas_ao_modelo=${caller.callCount - before}`);
        };

        for (const job of jobs) await run(`job-${job.id}`);
        master.requeue('job-executor');
        await run('job-executor (reentrega)');
        await run('fila vazia');

        console.log('\nO que o Master recebeu em POST /api/worker/result:');
        for (const body of master.acceptedResults) {
            if ('result' in body) {
                const { status, evidence, replayed } = body.result;
                const artifact = evidence.artifact_hashes.length ? ` artefato_sha256=${evidence.artifact_hashes[0].slice(0, 16)}...` : '';
                console.log(`  ${body.jobId.padEnd(26)} result: ${status} ${evidence.verdict} replay=${replayed}${artifact}`);
            } else {
                console.log(`  ${body.jobId.padEnd(26)} error:  ${body.error.replace(/ \[output_sha256=.*\]$/, '')}`);
            }
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
