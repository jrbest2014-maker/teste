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
            { id: 'executor', capability: 'vone_executor_execute', payload: { session_id: 'demo-session', objective: 'escrever relatorio.txt' } },
            { id: 'inferencia', capability: 'vone_inference_execute', payload: { prompt: 'diga oi', max_tokens: 64 } },
            { id: 'saida-fisica', capability: 'vone_inference_execute', payload: { prompt: 'mover extrusora', requires_physical_output: true } },
            { id: 'capability-desconhecida', capability: 'vone_rm_rf', payload: {} },
        ];
        for (const job of jobs) {
            master.enqueue({ job_id: `job-${job.id}`, task_id: `task-${job.id}`, idempotency_key: `idem-${job.id}`, capability: job.capability, payload: job.payload });
        }

        console.log('SIMULACAO LOCAL: Master mock em processo + respostas de modelo roteirizadas. Sem rede, sem custo.\n');
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
        master.redeliver('job-executor');
        await run('job-executor (reentrega)');
        await run('fila vazia');

        console.log('\nEvidencias aceitas pelo Master:');
        for (const result of master.acceptedResults) {
            const extra =
                result.output.kind === 'blocked'
                    ? ` gate=${result.output.category}`
                    : result.evidence.artifact_hashes.length
                      ? ` artefato_sha256=${result.evidence.artifact_hashes[0].slice(0, 16)}...`
                      : '';
            console.log(`  ${result.job_id.padEnd(30)} ${result.status.padEnd(9)} ${result.evidence.verdict.padEnd(5)} replay=${result.replayed}${extra}`);
        }
        console.log(`\ncheckpoint do Master: revisao ${master.checkpointRevision}`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
