import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { OllamaCaller } from './server/vone_ollama_caller';
import { WorkerConfigError, loadWorkerConfig } from './server/vone_worker_config';
import { MockMaster, startMockMasterServer, type MockJobSpec } from './server/testing/vone_mock_master';
import { evaluateSmokeEvidence, runE2ESmoke, type SmokeReport } from './vone_e2e_smoke';
import type { ModelRoute } from './server/vone_model_router';

/**
 * E2E smoke runner against a local mock Master (R1 wire over real HTTP on
 * 127.0.0.1) and a fake local Ollama. No external network; the tokens are
 * obviously fake and must never appear in anything the runner prints.
 */

const FAKE_TOKEN = 'FAKE-TEST-TOKEN-not-a-real-secret-0000';
const WRONG_TOKEN = 'FAKE-WRONG-TOKEN-not-a-real-secret-1111';
const FAKE_CF_TOKEN = 'FAKE-CF-AI-TOKEN-not-a-real-secret-2222';
const OLLAMA_MODEL = 'llama3.1:8b';

const WRITE_EVIDENCE = '{"action":"tool","toolName":"write_file","arguments":{"path":"evidence.txt","content":"e2e evidence"}}';
const FINISH = '{"action":"finish","summary":"wrote evidence.txt"}';

interface FakeOllama {
    readonly url: string;
    readonly requests: Array<{ path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }>;
    close(): Promise<void>;
}

async function startFakeOllama(responses: string[]): Promise<FakeOllama> {
    const requests: FakeOllama['requests'] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            requests.push({ path: req.url ?? '', headers: req.headers, body });
            const text = responses[Math.min(requests.length - 1, responses.length - 1)];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ model: body.model, response: text, done: true, eval_count: 7 }));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        requests,
        close: () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
            }),
    };
}

function executorJob(id: string): MockJobSpec {
    return { id: `job-${id}`, toolName: 'vone_executor_execute', args: { session_id: `session-${id}`, objective: 'write evidence.txt' } };
}

function workerEnv(masterUrl: string, ollamaUrl: string, root: string, extra: Record<string, string> = {}): Record<string, string> {
    return {
        VONE_MASTER_URL: masterUrl,
        VONE_WORKER_ID: 'worker-e2e',
        VONE_WORKER_TOKEN: FAKE_TOKEN,
        VONE_WORKER_ROOT: root,
        VONE_MODEL_ROUTE: 'ollama',
        VONE_OLLAMA_URL: ollamaUrl,
        VONE_OLLAMA_MODEL: OLLAMA_MODEL,
        ...extra,
    };
}

async function smoke(env: Record<string, string>): Promise<SmokeReport & { lines: string[] }> {
    const lines: string[] = [];
    const report = await runE2ESmoke({ env, waitMs: 3000, pollMs: 5, out: (line) => lines.push(line) });
    return { ...report, lines };
}

/** Runs the runner as a real child process so stdout/stderr are the real streams. */
function runCli(env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        execFile(
            process.execPath,
            ['-r', 'ts-node/register', path.join(__dirname, 'vone_e2e_smoke.ts')],
            { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TS_NODE_TRANSPILE_ONLY: '1', VONE_E2E_WAIT_MS: '5000', VONE_WORKER_POLL_MS: '20', ...env } },
            (error, stdout, stderr) => {
                const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 0;
                resolve({ code, stdout, stderr });
            },
        );
    });
}

function assertNoSecrets(texts: string[]): void {
    for (const text of texts) {
        for (const secret of [FAKE_TOKEN, WRONG_TOKEN, FAKE_CF_TOKEN]) {
            assert.ok(!text.includes(secret), `a secret leaked into output: ${text.slice(0, 200)}`);
        }
    }
}

async function main(): Promise<void> {
    const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), 'vone-e2e-smoke-'));
    const newRoot = (name: string): string => {
        const dir = path.join(tmpParent, name);
        fs.mkdirSync(dir);
        return dir;
    };
    const master = new MockMaster({ expectedToken: FAKE_TOKEN });
    const masterServer = await startMockMasterServer(master);

    try {
        // ------------------------------------------------------------------
        // 1. Full pass as a real process: fail-closed startup, authenticated
        //    heartbeat, claim, executor job run by VOneAgentLoop on local
        //    Ollama, evidence, result - PASS. Cloudflare credentials are
        //    present-but-unused here (route=ollama) and are never printed.
        // ------------------------------------------------------------------
        const root = newRoot('pass');
        const ollama = await startFakeOllama([WRITE_EVIDENCE, FINISH]);
        try {
            master.enqueue(executorJob('pass'));
            const run = await runCli(
                workerEnv(masterServer.url, ollama.url, root, { VONE_CF_ACCOUNT_ID: 'cf-account', VONE_CF_AI_TOKEN: FAKE_CF_TOKEN }),
            );
            assert.equal(run.code, 0, run.stdout + run.stderr);
            assert.equal(run.stderr, '');
            assertNoSecrets([run.stdout, run.stderr]);
            const lines = run.stdout.trim().split('\n');
            assert.equal(lines.length, 1, 'exactly one summary line');
            const summary = JSON.parse(lines[0]);
            assert.equal(summary.event, 'vone.e2e.summary');
            assert.equal(summary.verdict, 'PASS');
            assert.equal(summary.worker_token, 'present');
            assert.equal(summary.model_route, 'ollama');
            assert.equal(summary.model, OLLAMA_MODEL);
            assert.equal(summary.route_id, 'ollama-local');
            assert.ok(summary.heartbeats >= 1);
            assert.equal(typeof summary.heartbeat_generation, 'number');
            assert.deepEqual(summary.job, { id: 'job-pass', toolName: 'vone_executor_execute' });
            assert.equal(summary.executed_this_run, true);
            assert.equal(summary.master_ack, 'accepted');
            assert.equal(summary.status, 'DONE');
            assert.equal(summary.evidence_verdict, 'PASS');
            assert.equal(summary.artifact_hashes.length, 1);
            assert.ok(summary.checkpoint_revision > 0);
            assert.ok(Object.values(summary.checks).every((value) => value === true), JSON.stringify(summary.checks));
            for (const leaked of ['e2e evidence', 'write evidence.txt', 'wrote evidence.txt']) {
                assert.ok(!run.stdout.includes(leaked), 'job args and model output are not printed');
            }

            // Master side: exactly one accepted result for the job; local
            // model only: every model call went to Ollama's /api/generate.
            assert.equal(master.acceptedResults.length, 1);
            assert.equal(master.acceptedResults[0].jobId, 'job-pass');
            assert.deepEqual(master.jobState('job-pass'), { state: 'DONE', owner: 'worker-e2e' });
            assert.equal(ollama.requests.length, 2);
            for (const request of ollama.requests) {
                assert.equal(request.path, '/api/generate');
                assert.equal(request.body.model, OLLAMA_MODEL);
                assert.equal(request.body.stream, false);
                assert.equal(request.headers.authorization, undefined, 'no credential is sent to Ollama');
            }

            // 2. Idempotency: the Master re-delivers the same job id to a new
            //    run over the same worker root - replayed, never re-executed.
            master.requeue('job-pass');
            const again = await smoke(workerEnv(masterServer.url, ollama.url, root));
            assert.equal(again.exitCode, 0);
            assert.equal(again.summary.verdict, 'PASS');
            assert.equal(again.summary.executed_this_run, false);
            assert.equal(again.summary.replayed, true);
            assert.equal(ollama.requests.length, 2, 'no new model call on re-delivery');
            assert.equal(master.acceptedResults.length, 2);
        } finally {
            await ollama.close();
        }

        // ------------------------------------------------------------------
        // 3. DONE + evidence.verdict=HOLD stays HOLD (no artifact produced).
        // ------------------------------------------------------------------
        {
            const ollamaNoEvidence = await startFakeOllama([FINISH]);
            try {
                master.enqueue(executorJob('hold'));
                const run = await smoke(workerEnv(masterServer.url, ollamaNoEvidence.url, newRoot('hold')));
                assert.equal(run.exitCode, 2);
                assert.equal(run.summary.verdict, 'HOLD');
                assert.equal(run.summary.status, 'DONE');
                assert.equal(run.summary.evidence_verdict, 'HOLD');
                assert.equal(run.summary.master_ack, 'accepted');
                assert.equal(run.summary.reason, 'evidence_verdict_pass');
            } finally {
                await ollamaNoEvidence.close();
            }
        }

        // 4. Evidence the runner re-verifies: a tampered artifact or an
        //    incoherent checkpoint turns an otherwise PASS result into HOLD.
        {
            const evidenceRoot = newRoot('tamper');
            const ollamaTamper = await startFakeOllama([WRITE_EVIDENCE, FINISH]);
            try {
                master.enqueue(executorJob('tamper'));
                const run = await smoke(workerEnv(masterServer.url, ollamaTamper.url, evidenceRoot));
                assert.equal(run.summary.verdict, 'PASS');
            } finally {
                await ollamaTamper.close();
            }
            const { SandboxResultLedger } = await import('./server/vone_master_worker');
            const { VOneVFSSandbox } = await import('./core/vone_vfs_sandbox');
            const { VOneSessionHydrationEngine } = await import('./core/vone_session_hydration_engine');
            const workerSandbox = new VOneVFSSandbox(evidenceRoot);
            const entry = new SandboxResultLedger(workerSandbox).get('job-tamper');
            const checkpoint = new VOneSessionHydrationEngine(workerSandbox, 'sessions').hydrate('session-tamper', '');
            const read = (content: string | null) => () => content;

            assert.equal(evaluateSmokeEvidence({ entry, checkpoint, readArtifact: read('e2e evidence') }).verdict, 'PASS');
            const tampered = evaluateSmokeEvidence({ entry, checkpoint, readArtifact: read('e2e evidence, edited') });
            assert.deepEqual(tampered.failed, ['artifacts_on_disk_match']);
            const missing = evaluateSmokeEvidence({ entry, checkpoint, readArtifact: read(null) });
            assert.deepEqual(missing.failed, ['artifacts_on_disk_match']);
            const staleCheckpoint = evaluateSmokeEvidence({
                entry,
                checkpoint: { ...checkpoint, checkpointRevision: checkpoint.checkpointRevision - 1 },
                readArtifact: read('e2e evidence'),
            });
            assert.deepEqual(staleCheckpoint.failed, ['checkpoint_coherent']);
            assert.deepEqual(evaluateSmokeEvidence({ entry, checkpoint: null, readArtifact: read('e2e evidence') }).failed, [
                'checkpoint_present',
                'checkpoint_coherent',
            ]);
            const forgedHash = { ...entry!, result: { ...entry!.result, evidence: { ...entry!.result.evidence, output_sha256: '0'.repeat(64) } } };
            assert.deepEqual(evaluateSmokeEvidence({ entry: forgedHash, checkpoint, readArtifact: read('e2e evidence') }).failed, [
                'output_hash_valid',
            ]);
            assert.equal(evaluateSmokeEvidence({ entry: undefined, checkpoint, readArtifact: read('e2e evidence') }).verdict, 'HOLD');
        }

        // ------------------------------------------------------------------
        // 5. Only vone_executor_execute: any other toolName is neither run
        //    nor submitted, and the run ends HOLD.
        // ------------------------------------------------------------------
        {
            const ollamaUnused = await startFakeOllama(['must never be produced']);
            try {
                master.enqueue({ id: 'job-inference', toolName: 'vone_inference_execute', args: { prompt: 'x' } });
                const accepted = master.acceptedResults.length;
                const rejected = master.rejectedResults.length;
                const run = await smoke(workerEnv(masterServer.url, ollamaUnused.url, newRoot('non-executor')));
                assert.equal(run.exitCode, 2);
                assert.equal(run.summary.reason, 'NON_EXECUTOR_JOB');
                assert.deepEqual(run.summary.job, { id: 'job-inference', toolName: 'vone_inference_execute' });
                assert.equal(ollamaUnused.requests.length, 0);
                assert.equal(master.acceptedResults.length, accepted);
                assert.equal(master.rejectedResults.length, rejected);
            } finally {
                await ollamaUnused.close();
            }
        }

        // ------------------------------------------------------------------
        // 6. Negative startup / auth cases.
        // ------------------------------------------------------------------
        {
            const ollamaUnused = await startFakeOllama(['must never be produced']);
            try {
                const requestsBefore = masterServer.requests.count;

                // 6a. No VONE_WORKER_TOKEN: refused before any network call.
                const noToken = workerEnv(masterServer.url, ollamaUnused.url, newRoot('no-token'));
                delete (noToken as Record<string, string | undefined>).VONE_WORKER_TOKEN;
                const noTokenRun = await smoke(noToken);
                assert.equal(noTokenRun.exitCode, 78);
                assert.equal(noTokenRun.summary.reason, 'CONFIG_REFUSED');
                assert.ok((noTokenRun.summary.missing_or_invalid as string[]).includes('VONE_WORKER_TOKEN'));

                // 6b. Cloudflare route selected without credentials: refused at
                //     startup, no fallback route, no Master or model call.
                const cfRun = await smoke(
                    workerEnv(masterServer.url, ollamaUnused.url, newRoot('cf-no-creds'), { VONE_MODEL_ROUTE: 'cloudflare' }),
                );
                assert.equal(cfRun.exitCode, 78);
                assert.deepEqual((cfRun.summary.missing_or_invalid as string[]).sort(), ['VONE_CF_ACCOUNT_ID', 'VONE_CF_AI_TOKEN']);

                // 6c. Only a truly local Ollama counts as zero-cost.
                const remote = await smoke(
                    workerEnv(masterServer.url, 'http://ollama.example.com:11434', newRoot('remote-ollama')),
                );
                assert.equal(remote.exitCode, 78);
                assert.deepEqual(remote.summary.missing_or_invalid, ['VONE_OLLAMA_URL']);
                const cloudModel = await smoke(
                    workerEnv(masterServer.url, ollamaUnused.url, newRoot('cloud-model'), { VONE_OLLAMA_MODEL: 'gpt-oss:120b-cloud' }),
                );
                assert.equal(cloudModel.exitCode, 78);
                assert.deepEqual(cloudModel.summary.missing_or_invalid, ['VONE_OLLAMA_MODEL']);

                assert.equal(masterServer.requests.count, requestsBefore, 'refused startups never reach the Master');
                assert.equal(ollamaUnused.requests.length, 0);
                assertNoSecrets([...noTokenRun.lines, ...cfRun.lines, ...remote.lines, ...cloudModel.lines]);

                // 6d. Invalid token, as a real process: 401 -> fail-closed, exit 77,
                //     nothing claimed or run, no secret on stdout/stderr.
                master.enqueue(executorJob('wrong-token'));
                const wrong = await runCli(
                    workerEnv(masterServer.url, ollamaUnused.url, newRoot('wrong-token'), { VONE_WORKER_TOKEN: WRONG_TOKEN }),
                );
                assert.equal(wrong.code, 77, wrong.stdout + wrong.stderr);
                assertNoSecrets([wrong.stdout, wrong.stderr]);
                const summary = JSON.parse(wrong.stdout.trim());
                assert.equal(summary.verdict, 'FAIL_CLOSED');
                assert.equal(summary.reason, 'AUTH_REJECTED');
                assert.deepEqual(master.jobState('job-wrong-token'), { state: 'QUEUED', owner: null });
                assert.equal(ollamaUnused.requests.length, 0);
            } finally {
                await ollamaUnused.close();
            }
        }

        // ------------------------------------------------------------------
        // 7. Cloudflare credentials absent do not block a purely local worker,
        //    and the configuration picks only the requested backend.
        // ------------------------------------------------------------------
        {
            const base = { VONE_MASTER_URL: 'https://master.example.invalid', VONE_WORKER_ID: 'w', VONE_WORKER_TOKEN: FAKE_TOKEN };
            const local = loadWorkerConfig({ ...base, VONE_OLLAMA_MODEL: OLLAMA_MODEL });
            assert.equal(local.modelRoute, 'ollama');
            assert.equal(local.cloudflareAi, null);
            assert.equal(local.ollama?.baseUrl, 'http://127.0.0.1:11434');
            assert.throws(() => loadWorkerConfig({ ...base, VONE_MODEL_ROUTE: 'paid' }), WorkerConfigError);
            assert.throws(() => loadWorkerConfig({ ...base, VONE_MODEL_ROUTE: 'ollama' }), WorkerConfigError);
            assert.equal(loadWorkerConfig(base).modelRoute, null);
        }

        // ------------------------------------------------------------------
        // 8. OllamaCaller contract: request shape and failure paths.
        // ------------------------------------------------------------------
        {
            const route: ModelRoute = { id: 'ollama-local', tier: 'free', model: OLLAMA_MODEL, costPerMTokUsd: 0, state: 'FREE_AVAILABLE', neuronsUsedToday: 0 };
            const reply = (status: number, body: unknown) =>
                (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
            const ok = new OllamaCaller({ baseUrl: 'http://127.0.0.1:11434/', fetchImpl: reply(200, { response: 'hi', done: true }) });
            assert.deepEqual(await ok.run(route, { prompt: 'p', maxTokens: 64 }), { text: 'hi', neuronsUsed: 0 });
            for (const [status, body, pattern] of [
                [404, { error: "model 'llama3.1:8b' not found" }, /HTTP 404/],
                [200, { error: 'out of memory' }, /out of memory/],
                [200, { response: 'partial', done: false }, /not a completed generation/],
                [200, 'not json', /non-JSON/],
            ] as const) {
                const caller = new OllamaCaller({ baseUrl: 'http://127.0.0.1:11434', fetchImpl: reply(status, body) });
                await assert.rejects(() => caller.run(route, { prompt: 'p' }), pattern);
            }
            const hanging = (async (_url: unknown, init?: RequestInit) =>
                new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
            await assert.rejects(
                () => new OllamaCaller({ baseUrl: 'http://127.0.0.1:11434', timeoutMs: 20, fetchImpl: hanging }).run(route, { prompt: 'p' }),
                /timed out after 20ms/,
            );
        }

        console.log('vone_e2e_smoke: all assertions passed (local mock Master + fake Ollama - not the live preview)');
    } finally {
        await masterServer.close();
        fs.rmSync(tmpParent, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
