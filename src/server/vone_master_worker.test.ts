import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { VOneVFSSandbox } from '../core/vone_vfs_sandbox';
import { VOneHydrationEngine } from '../core/vone_hydration_engine';
import { VOneUnifiedHubAgent } from '../core/vone_unified_hub_agent';
import { VOneExecutor } from './vone_executor';
import {
    ModelRouter,
    createDefaultGates,
    type InferenceRequest,
    type ModelCaller,
    type ModelRoute,
    type RoutingGates,
} from './vone_model_router';
import {
    REQUIRED_GATES,
    SUPPORTED_CAPABILITIES,
    TransportError,
    type BlockedJobOutput,
    type ErrorJobOutput,
    type ExecutorJobOutput,
    type InferenceJobOutput,
    type MasterTransport,
} from './vone_execution_contract';
import {
    InMemoryResultLedger,
    SandboxResultLedger,
    VOneMasterWorker,
    type TickOutcome,
    type WorkerLogEvent,
    type WorkerResultLedger,
} from './vone_master_worker';
import { HttpMasterTransport } from './vone_http_master_transport';
import {
    WorkerConfigError,
    createWorkerCredential,
    describeWorkerConfig,
    loadWorkerConfig,
} from './vone_worker_config';
import { createWorkerFromConfig, createWorkerFromEnv } from './vone_worker_factory';
import { InProcessMasterTransport, MockMaster, startMockMasterServer } from './testing/vone_mock_master';

/**
 * Executor-side integration tests for VONE_EXECUTION_CONTRACT_R1 against a
 * LOCAL mock Master (in-process and real HTTP on 127.0.0.1). No external
 * network, no real credential: the tokens below are obviously fake and the
 * final block proves they never reach logs, results or the ledger.
 */

const FAKE_TOKEN = 'FAKE-TEST-TOKEN-not-a-real-secret-0000';
const WRONG_TOKEN = 'FAKE-WRONG-TOKEN-not-a-real-secret-1111';

const allLogs: WorkerLogEvent[] = [];
const allOutcomes: TickOutcome[] = [];
const allMasters: MockMaster[] = [];
const ledgerFiles: string[] = [];

class ScriptedCaller implements ModelCaller {
    public callCount = 0;
    private index = 0;
    constructor(
        private readonly responses: string[],
        private readonly onRun?: (callNumber: number) => Promise<void>,
    ) {}

    public async run(_route: ModelRoute, _request: InferenceRequest) {
        this.callCount += 1;
        if (this.onRun) await this.onRun(this.callCount);
        const text = this.responses[Math.min(this.index, this.responses.length - 1)];
        this.index += 1;
        return { text, neuronsUsed: 1 };
    }
}

class ThrowingCaller implements ModelCaller {
    public callCount = 0;
    public async run(): Promise<{ text: string; neuronsUsed: number }> {
        this.callCount += 1;
        throw new Error('upstream exploded; api_key=sk-THISLOOKSLIKEASECRETVALUE1234567890');
    }
}

function freeRoute(id = 'worker-free-route'): ModelRoute {
    return { id, tier: 'free', model: 'test-model', costPerMTokUsd: 0, state: 'FREE_AVAILABLE', neuronsUsedToday: 0 };
}
function paidRoute(): ModelRoute {
    return { id: 'worker-paid-route', tier: 'paid', model: 'paid-model', costPerMTokUsd: 5, state: 'FREE_AVAILABLE', neuronsUsedToday: 0 };
}
function unknownCostRoute(): ModelRoute {
    return { id: 'worker-unknown-cost', tier: 'free', model: 'mystery', costPerMTokUsd: null, state: 'FREE_AVAILABLE', neuronsUsedToday: 0 };
}

function sha256(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

interface Stack {
    sandbox: VOneVFSSandbox;
    gates: RoutingGates;
    counts: { execute: number; dispatch: number };
    executorPort: { execute: VOneExecutor['execute'] };
    inferencePort: { dispatch: ModelRouter['dispatch'] };
}

function makeStack(root: string, caller: ModelCaller, routes: ModelRoute[] = [freeRoute()]): Stack {
    const sandbox = new VOneVFSSandbox(root);
    const hydration = new VOneHydrationEngine(sandbox);
    const gates = createDefaultGates();
    const router = new ModelRouter(routes, gates, caller);
    const executor = new VOneExecutor(new VOneUnifiedHubAgent(sandbox, router), hydration);
    const counts = { execute: 0, dispatch: 0 };
    return {
        sandbox,
        gates,
        counts,
        executorPort: {
            execute: (request) => {
                counts.execute += 1;
                return executor.execute(request);
            },
        },
        inferencePort: {
            dispatch: (request) => {
                counts.dispatch += 1;
                return router.dispatch(request);
            },
        },
    };
}

function makeWorker(workerId: string, transport: MasterTransport, stack: Stack, ledger?: WorkerResultLedger): VOneMasterWorker {
    return new VOneMasterWorker({
        workerId,
        transport,
        executor: stack.executorPort,
        inference: stack.inferencePort,
        gates: stack.gates,
        ledger,
        submitRetry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
        sleep: async () => {},
        log: (event) => allLogs.push(event),
    });
}

function newMaster(options: { leaseMs?: number } = {}): MockMaster {
    const master = new MockMaster({ expectedToken: FAKE_TOKEN, leaseMs: options.leaseMs });
    allMasters.push(master);
    return master;
}

async function tick(worker: VOneMasterWorker): Promise<TickOutcome> {
    const outcome = await worker.runOnce();
    allOutcomes.push(outcome);
    return outcome;
}

function inferenceJob(id: string, payload: Record<string, unknown> = { prompt: 'say hi', max_tokens: 64 }) {
    return { job_id: `job-${id}`, task_id: `task-${id}`, idempotency_key: `idem-${id}`, capability: 'vone_inference_execute', payload };
}
function executorJob(id: string, objective = 'write the result file') {
    return {
        job_id: `job-${id}`,
        task_id: `task-${id}`,
        idempotency_key: `idem-${id}`,
        capability: 'vone_executor_execute',
        payload: { session_id: `session-${id}`, objective },
    };
}

async function main(): Promise<void> {
    const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), 'vone-master-worker-'));
    const newRoot = (name: string): string => {
        const dir = path.join(tmpParent, name);
        fs.mkdirSync(dir);
        return dir;
    };

    try {
        // ------------------------------------------------------------------
        // 1. Empty claim: heartbeat advertises capabilities + strict gates,
        //    nothing is executed and nothing is submitted.
        // ------------------------------------------------------------------
        {
            const master = newMaster();
            const transport = new InProcessMasterTransport(master, FAKE_TOKEN);
            const caller = new ScriptedCaller(['{"action":"finish","summary":"unreachable"}']);
            const stack = makeStack(newRoot('empty'), caller);
            const worker = makeWorker('worker-A', transport, stack);

            const outcome = await tick(worker);
            assert.deepEqual(outcome, { kind: 'idle' });
            assert.equal(master.heartbeats.length, 1);
            assert.deepEqual(master.heartbeats[0].capabilities, [...SUPPORTED_CAPABILITIES]);
            assert.deepEqual(master.heartbeats[0].capabilities, ['vone_executor_execute', 'vone_inference_execute']);
            assert.deepEqual(master.heartbeats[0].gates, REQUIRED_GATES);
            assert.equal(master.claims.length, 1);
            assert.equal(transport.calls.submitResult, 0);
            assert.equal(stack.counts.execute + stack.counts.dispatch, 0);
            assert.equal(caller.callCount, 0);

            // single-flight: a second concurrent tick does not start another cycle
            const [first, second] = await Promise.all([worker.runOnce(), worker.runOnce()]);
            assert.deepEqual(first, { kind: 'idle' });
            assert.deepEqual(second, { kind: 'busy' });
        }

        // The worker refuses to exist with loosened gates.
        {
            const master = newMaster();
            const stack = makeStack(newRoot('gates'), new ScriptedCaller(['x']));
            for (const loosened of [
                { ...createDefaultGates(), physicalOutput: 'UNLOCKED' },
                { ...createDefaultGates(), paidBlocked: 'OPEN' },
                { ...createDefaultGates(), unknownCost: 'ALLOW' },
            ]) {
                assert.throws(
                    () =>
                        new VOneMasterWorker({
                            workerId: 'worker-A',
                            transport: new InProcessMasterTransport(master, FAKE_TOKEN),
                            executor: stack.executorPort,
                            inference: stack.inferencePort,
                            gates: loosened as unknown as RoutingGates,
                        }),
                    /refusing to start/,
                );
            }
        }

        // ------------------------------------------------------------------
        // 2. Executor job -> VOneExecutor -> VOneAgentLoop -> result + evidence.
        // ------------------------------------------------------------------
        {
            const master = newMaster();
            const transport = new InProcessMasterTransport(master, FAKE_TOKEN);
            const caller = new ScriptedCaller([
                '{"action":"tool","toolName":"write_file","arguments":{"path":"result.txt","content":"executor-output"}}',
                '{"action":"finish","summary":"wrote result.txt"}',
            ]);
            const stack = makeStack(newRoot('executor'), caller);
            const ledger = new InMemoryResultLedger();
            const worker = makeWorker('worker-A', transport, stack, ledger);
            master.enqueue(executorJob('exec-1'));

            const outcome = await tick(worker);
            assert.equal(outcome.kind, 'completed');
            if (outcome.kind !== 'completed') throw new Error('unreachable');
            assert.equal(outcome.status, 'DONE');
            assert.equal(outcome.verdict, 'PASS');
            assert.equal(outcome.executed, true);
            assert.equal(outcome.replayed, false);

            assert.equal(master.acceptedResults.length, 1);
            const submitted = master.acceptedResults[0];
            assert.equal(submitted.worker_id, 'worker-A');
            assert.equal(submitted.task_id, 'task-exec-1');
            assert.equal(submitted.idempotency_key, 'idem-exec-1');
            assert.deepEqual(submitted.gates, REQUIRED_GATES);
            const output = submitted.output as ExecutorJobOutput;
            assert.equal(output.kind, 'executor');
            assert.equal(output.agent_status, 'DONE');
            assert.equal(output.summary, 'wrote result.txt');
            assert.equal(output.route_id, 'worker-free-route');
            assert.deepEqual(output.artifacts, [{ path: 'result.txt', sha256: sha256('executor-output') }]);
            assert.deepEqual(submitted.evidence.artifact_hashes, [sha256('executor-output')]);
            assert.match(submitted.evidence.output_sha256, /^[0-9a-f]{64}$/);
            assert.equal(stack.sandbox.readFile('result.txt'), 'executor-output');
            assert.equal(caller.callCount, 2);
            assert.equal(stack.counts.execute, 1);
            assert.equal(stack.counts.dispatch, 0);
            assert.deepEqual(master.jobState('job-exec-1'), { state: 'DONE', owner: 'worker-A' });
            const entry = ledger.get('idem-exec-1');
            assert.equal(entry?.state, 'SUBMITTED');
            assert.equal(entry?.master_checkpoint_revision, 1);
        }

        // NO_EVIDENCE_NO_PASS: an executor run that finishes without producing
        // any artifact is DONE but HOLD, never PASS.
        {
            const master = newMaster();
            const caller = new ScriptedCaller(['{"action":"finish","summary":"claimed success, no evidence"}']);
            const stack = makeStack(newRoot('no-evidence'), caller);
            const worker = makeWorker('worker-A', new InProcessMasterTransport(master, FAKE_TOKEN), stack);
            master.enqueue(executorJob('exec-noevidence'));
            const outcome = await tick(worker);
            assert.equal(outcome.kind === 'completed' && outcome.status, 'DONE');
            assert.equal(outcome.kind === 'completed' && outcome.verdict, 'HOLD');
            assert.equal(master.acceptedResults[0].evidence.verdict_reason, 'NO_EVIDENCE');
        }

        // ------------------------------------------------------------------
        // 3. Inference job -> exactly one gated ModelRouter.dispatch(), no loop.
        // ------------------------------------------------------------------
        {
            const master = newMaster();
            const caller = new ScriptedCaller(['inference-answer']);
            const stack = makeStack(newRoot('inference'), caller);
            const worker = makeWorker('worker-A', new InProcessMasterTransport(master, FAKE_TOKEN), stack);
            master.enqueue(inferenceJob('inf-1'));

            const outcome = await tick(worker);
            assert.equal(outcome.kind, 'completed');
            assert.equal(outcome.kind === 'completed' && outcome.verdict, 'PASS');
            const output = master.acceptedResults[0].output as InferenceJobOutput;
            assert.deepEqual(output, {
                kind: 'inference',
                text: 'inference-answer',
                route_id: 'worker-free-route',
                model: 'test-model',
                neurons_used: 1,
            });
            assert.equal(caller.callCount, 1);
            assert.equal(stack.counts.dispatch, 1);
            assert.equal(stack.counts.execute, 0);
            assert.equal(fs.existsSync(path.join(stack.sandbox.getProjectRoot(), '.vone_agent_state.json')), false);
        }

        // Gates are enforced by the router, not re-derived by the worker: each
        // block becomes a BLOCKED result carrying RoutingBlockedError.category,
        // with zero model calls - and nothing in the job can loosen a gate.
        {
            const cases: Array<{ name: string; routes: ModelRoute[]; payload: Record<string, unknown>; category: string }> = [
                {
                    name: 'paid',
                    routes: [paidRoute()],
                    payload: { prompt: 'spend', gates: { paid_blocked: 'UNLOCKED' }, allow_paid: true, route: 'PAID' },
                    category: 'paidBlocked',
                },
                { name: 'unknown-cost', routes: [unknownCostRoute()], payload: { prompt: 'x' }, category: 'unknownCost' },
                {
                    name: 'physical',
                    routes: [freeRoute()],
                    payload: { prompt: 'G1 X10', requires_physical_output: true, physical_output: 'UNLOCKED' },
                    category: 'physicalOutputLocked',
                },
            ];
            for (const testCase of cases) {
                const master = newMaster();
                const caller = new ScriptedCaller(['must never be produced']);
                const stack = makeStack(newRoot(`blocked-${testCase.name}`), caller, testCase.routes);
                const worker = makeWorker('worker-A', new InProcessMasterTransport(master, FAKE_TOKEN), stack);
                master.enqueue(inferenceJob(`blocked-${testCase.name}`, testCase.payload));

                const outcome = await tick(worker);
                assert.equal(outcome.kind === 'completed' && outcome.status, 'BLOCKED', testCase.name);
                assert.equal(outcome.kind === 'completed' && outcome.verdict, 'BLOCKED', testCase.name);
                const output = master.acceptedResults[0].output as BlockedJobOutput;
                assert.equal(output.kind, 'blocked');
                assert.equal(output.category, testCase.category);
                assert.equal(master.acceptedResults[0].evidence.verdict_reason, testCase.category);
                assert.equal(caller.callCount, 0, `${testCase.name}: model must not be called`);
                assert.deepEqual(master.acceptedResults[0].gates, REQUIRED_GATES);
            }

            // Same for the full executor path.
            const master = newMaster();
            const caller = new ScriptedCaller(['{"action":"finish","summary":"unreachable"}']);
            const stack = makeStack(newRoot('blocked-executor'), caller, [paidRoute()]);
            const worker = makeWorker('worker-A', new InProcessMasterTransport(master, FAKE_TOKEN), stack);
            master.enqueue(executorJob('blocked-exec'));
            const outcome = await tick(worker);
            assert.equal(outcome.kind === 'completed' && outcome.verdict, 'BLOCKED');
            const output = master.acceptedResults[0].output as ExecutorJobOutput;
            assert.equal(output.agent_status, 'BLOCKED');
            assert.equal(output.gate_decisions[0]?.category, 'paidBlocked');
            assert.equal(caller.callCount, 0);
        }

        // ------------------------------------------------------------------
        // 4. Errors: unknown capability, invalid payload, execution error,
        //    malformed claim. Nothing unsupported/invalid is ever executed.
        // ------------------------------------------------------------------
        {
            const master = newMaster();
            const caller = new ScriptedCaller(['must never be produced']);
            const stack = makeStack(newRoot('errors'), caller);
            const worker = makeWorker('worker-A', new InProcessMasterTransport(master, FAKE_TOKEN), stack);

            master.enqueue({ ...inferenceJob('unknown-cap'), capability: 'vone_shell_execute' });
            let outcome = await tick(worker);
            assert.equal(outcome.kind === 'completed' && outcome.status, 'REJECTED');
            assert.equal(outcome.kind === 'completed' && outcome.verdict, 'FAIL');
            let output = master.acceptedResults[0].output as ErrorJobOutput;
            assert.equal(output.error_code, 'UNSUPPORTED_CAPABILITY');
            assert.match(output.message, /vone_shell_execute/);

            master.enqueue({ ...executorJob('bad-payload'), payload: { session_id: 's' } });
            outcome = await tick(worker);
            assert.equal(outcome.kind === 'completed' && outcome.status, 'REJECTED');
            output = master.acceptedResults[1].output as ErrorJobOutput;
            assert.equal(output.error_code, 'INVALID_PAYLOAD');
            assert.match(output.message, /objective/);

            assert.equal(stack.counts.execute, 0);
            assert.equal(stack.counts.dispatch, 0);
            assert.equal(caller.callCount, 0);

            master.returnMalformedNextClaim();
            outcome = await tick(worker);
            assert.equal(outcome.kind, 'protocol_error');
            assert.equal(outcome.kind === 'protocol_error' && outcome.phase, 'claim');
            assert.equal(stack.counts.execute + stack.counts.dispatch, 0);
        }
        {
            const master = newMaster();
            const caller = new ThrowingCaller();
            const stack = makeStack(newRoot('exec-error'), caller);
            const worker = makeWorker('worker-A', new InProcessMasterTransport(master, FAKE_TOKEN), stack);
            master.enqueue(inferenceJob('throws'));
            const outcome = await tick(worker);
            assert.equal(outcome.kind === 'completed' && outcome.status, 'FAILED');
            assert.equal(outcome.kind === 'completed' && outcome.verdict, 'FAIL');
            const output = master.acceptedResults[0].output as ErrorJobOutput;
            assert.equal(output.error_code, 'EXECUTION_ERROR');
            assert.match(output.message, /upstream exploded/);
            assert.match(output.message, /\[REDACTED\]/);
            assert.ok(!output.message.includes('sk-THISLOOKSLIKEASECRET'), 'secret-shaped text must be redacted');
            assert.equal(caller.callCount, 1);
        }

        // ------------------------------------------------------------------
        // 5. Idempotent retry.
        // ------------------------------------------------------------------
        {
            const master = newMaster();
            const transport = new InProcessMasterTransport(master, FAKE_TOKEN);
            const caller = new ScriptedCaller(['idempotent-answer']);
            const stack = makeStack(newRoot('idempotent'), caller);
            const ledger = new InMemoryResultLedger();
            const worker = makeWorker('worker-A', transport, stack, ledger);
            master.enqueue(inferenceJob('idem'));

            // 5a. Master applied the result but the ack was lost: the retry is
            //     acknowledged as a duplicate, the job ran exactly once.
            transport.dropNextAcks = 1;
            let outcome = await tick(worker);
            assert.equal(outcome.kind, 'completed');
            assert.equal(outcome.kind === 'completed' && outcome.duplicate, true);
            assert.equal(outcome.kind === 'completed' && outcome.executed, true);
            assert.equal(transport.calls.submitResult, 2);
            assert.equal(master.acceptedResults.length, 1);
            assert.equal(master.duplicateResults.length, 1);
            assert.equal(caller.callCount, 1);

            // 5b. Master re-delivers the same idempotency_key under a new lease:
            //     the stored result is resubmitted, nothing is re-executed.
            master.redeliver('job-idem');
            outcome = await tick(worker);
            assert.equal(outcome.kind, 'completed');
            assert.equal(outcome.kind === 'completed' && outcome.executed, false);
            assert.equal(outcome.kind === 'completed' && outcome.replayed, true);
            assert.equal(caller.callCount, 1, 're-delivery must not re-run the model');
            assert.equal(stack.counts.dispatch, 1, 're-delivery must not re-dispatch');
            assert.equal(master.acceptedResults.length, 2);
            const [firstResult, replayedResult] = master.acceptedResults;
            assert.notEqual(firstResult.lease_id, replayedResult.lease_id);
            assert.equal(replayedResult.replayed, true);
            assert.deepEqual(replayedResult.output, firstResult.output);
            assert.equal(replayedResult.evidence.output_sha256, firstResult.evidence.output_sha256);

            // 5c. Submit keeps failing: result is held (not recomputed) and
            //     delivered on the next tick once the Master is reachable.
            master.enqueue(inferenceJob('idem-deferred'));
            transport.failNextSubmits = 3; // == maxAttempts
            outcome = await tick(worker);
            assert.equal(outcome.kind, 'submit_deferred');
            assert.equal(ledger.pending().length, 1);
            const callsAfterCompute = caller.callCount;
            outcome = await tick(worker);
            assert.deepEqual(outcome, { kind: 'idle' }); // flushed pending, then nothing new to claim
            assert.equal(ledger.pending().length, 0);
            assert.equal(caller.callCount, callsAfterCompute);
            assert.equal(master.jobState('job-idem-deferred').state, 'DONE');
        }

        // ------------------------------------------------------------------
        // 6. Missing token: fail-closed before any network call; tokens never
        //    serialized; wrong token is rejected and the worker stops.
        // ------------------------------------------------------------------
        {
            const baseEnv = { VONE_MASTER_URL: 'http://127.0.0.1:9', VONE_WORKER_ID: 'worker-A' };
            for (const env of [baseEnv, { ...baseEnv, VONE_WORKER_TOKEN: '' }, { ...baseEnv, VONE_WORKER_TOKEN: '   ' }]) {
                assert.throws(
                    () => loadWorkerConfig(env),
                    (error: unknown) =>
                        error instanceof WorkerConfigError && error.missingOrInvalid.includes('VONE_WORKER_TOKEN'),
                );
            }

            let fetchCalls = 0;
            const spyFetch = (async () => {
                fetchCalls += 1;
                throw new Error('network must not be reached');
            }) as unknown as typeof fetch;
            assert.throws(
                () => createWorkerFromEnv(baseEnv, { fetchImpl: spyFetch, caller: new ScriptedCaller(['x']) }),
                WorkerConfigError,
            );
            assert.equal(fetchCalls, 0, 'no network call may happen without a token');

            assert.throws(
                () => new HttpMasterTransport({ baseUrl: 'http://127.0.0.1:9', credential: undefined as never, fetchImpl: spyFetch }),
                (error: unknown) => error instanceof TransportError && error.kind === 'auth',
            );
            assert.equal(fetchCalls, 0);

            assert.throws(() => loadWorkerConfig({ ...baseEnv, VONE_WORKER_TOKEN: FAKE_TOKEN, VONE_MASTER_URL: 'http://example.com' }), WorkerConfigError);
            assert.throws(
                () => loadWorkerConfig({ ...baseEnv, VONE_WORKER_TOKEN: FAKE_TOKEN, VONE_MASTER_URL: 'https://user:pw@example.com' }),
                WorkerConfigError,
            );
            assert.throws(() => loadWorkerConfig({ ...baseEnv, VONE_WORKER_TOKEN: FAKE_TOKEN, VONE_CF_ACCOUNT_ID: 'acc' }), WorkerConfigError);

            const config = loadWorkerConfig({ ...baseEnv, VONE_WORKER_TOKEN: FAKE_TOKEN, VONE_MASTER_URL: 'https://master.example.invalid/' });
            assert.equal(config.masterUrl, 'https://master.example.invalid');
            assert.equal(describeWorkerConfig(config).token, 'present');
            assert.equal(describeWorkerConfig(config).cloudflareAiToken, 'absent');
            for (const rendering of [
                JSON.stringify(config),
                JSON.stringify(describeWorkerConfig(config)),
                inspect(config, { depth: 10 }),
                String(config.credential),
                `${config.credential}`,
            ]) {
                assert.ok(!rendering.includes(FAKE_TOKEN), 'token must not render');
            }
            // Without an injected caller and without VONE_CF_* the factory refuses (no model route).
            assert.throws(() => createWorkerFromConfig(config, { fetchImpl: spyFetch }), WorkerConfigError);
            assert.equal(fetchCalls, 0);

            // Transport error messages never echo the token, even if the
            // underlying error does.
            const echoingFetch = (async (_url: unknown, init?: RequestInit) => {
                throw new Error(`socket closed, sent header ${JSON.stringify(init?.headers)}`);
            }) as unknown as typeof fetch;
            const echoTransport = new HttpMasterTransport({
                baseUrl: 'http://127.0.0.1:9',
                credential: createWorkerCredential(FAKE_TOKEN),
                fetchImpl: echoingFetch,
            });
            await assert.rejects(
                () => echoTransport.claim({ contract: 'VONE_EXECUTION_CONTRACT_R1', worker_id: 'w', capabilities: [] }),
                (error: unknown) => {
                    assert.ok(error instanceof TransportError);
                    assert.equal(error.retryable, true);
                    assert.ok(!error.message.includes(FAKE_TOKEN));
                    assert.match(error.message, /REDACTED/);
                    return true;
                },
            );

            // Wrong token against a real HTTP mock: rejected, nothing runs, loop stops.
            const master = newMaster();
            const server = await startMockMasterServer(master);
            try {
                master.enqueue(inferenceJob('wrong-token'));
                const caller = new ScriptedCaller(['must never be produced']);
                const stack = makeStack(newRoot('wrong-token'), caller);
                const transport = new HttpMasterTransport({ baseUrl: server.url, credential: createWorkerCredential(WRONG_TOKEN) });
                const worker = makeWorker('worker-A', transport, stack);
                const outcomes = await worker.run({ maxTicks: 5, idleDelayMs: 1 });
                allOutcomes.push(...outcomes);
                assert.equal(outcomes.length, 1, 'auth rejection must stop the loop (fail-closed)');
                assert.equal(outcomes[0].kind, 'auth_rejected');
                assert.ok(master.authFailures >= 1);
                assert.equal(master.claims.length, 0);
                assert.equal(caller.callCount, 0);
                assert.deepEqual(master.jobState('job-wrong-token'), { state: 'QUEUED', owner: null });
            } finally {
                await server.close();
            }
        }

        // ------------------------------------------------------------------
        // 7. Ownership: result for a job this worker no longer owns; claim
        //    envelope naming another worker; lease already expired.
        // ------------------------------------------------------------------
        {
            // 7a. Worker A's lease expires mid-execution and the Master hands
            //     the job to worker B, which completes it. A's late result is
            //     rejected WRONG_WORKER; A records it, does not retry and does
            //     not re-execute.
            const master = newMaster();
            const transportA = new InProcessMasterTransport(master, FAKE_TOKEN);
            const transportB = new InProcessMasterTransport(master, FAKE_TOKEN);
            const callerB = new ScriptedCaller(['answer-from-B']);
            const stackB = makeStack(newRoot('owner-B'), callerB);
            const workerB = makeWorker('worker-B', transportB, stackB);

            let outcomeB: TickOutcome | null = null;
            const callerA = new ScriptedCaller(['answer-from-A'], async () => {
                master.expireLease('job-owned');
                outcomeB = await tick(workerB);
            });
            const stackA = makeStack(newRoot('owner-A'), callerA);
            const ledgerA = new InMemoryResultLedger();
            const workerA = makeWorker('worker-A', transportA, stackA, ledgerA);
            master.enqueue(inferenceJob('owned'));

            const outcome = await tick(workerA);
            const takeover = outcomeB as TickOutcome | null;
            assert.equal(takeover?.kind === 'completed' && takeover.executed, true, 'worker B must take over the expired lease');
            assert.equal(callerB.callCount, 1);
            assert.equal(outcome.kind, 'result_rejected');
            assert.equal(outcome.kind === 'result_rejected' && outcome.reason, 'WRONG_WORKER');
            assert.equal(transportA.calls.submitResult, 1, 'an ownership rejection is not retried');
            assert.equal(ledgerA.get('idem-owned')?.state, 'REJECTED_BY_MASTER');
            assert.equal(master.acceptedResults.length, 1);
            assert.equal(master.acceptedResults[0].worker_id, 'worker-B');
            assert.equal((master.acceptedResults[0].output as InferenceJobOutput).text, 'answer-from-B');
            assert.equal(master.rejectedResults[0].reason, 'WRONG_WORKER');
            assert.equal(master.rejectedResults[0].submission.worker_id, 'worker-A');
            assert.deepEqual(master.jobState('job-owned'), { state: 'DONE', owner: 'worker-B' });

            const again = await tick(workerA);
            assert.deepEqual(again, { kind: 'idle' });
            assert.equal(transportA.calls.submitResult, 1, 'rejected result is not re-flushed');
            assert.equal(callerA.callCount, 1, 'rejected job is never re-executed');

            // 7b. Mock-level check: a fabricated submission from a non-owner is refused.
            const forged = { ...master.acceptedResults[0], worker_id: 'worker-A' };
            const forgedResponse = master.handleResult(FAKE_TOKEN, forged);
            assert.equal(forgedResponse.status, 409);
            assert.deepEqual(forgedResponse.body, { accepted: false, reason: 'WRONG_WORKER' });
        }
        {
            // 7c. A (buggy) Master hands this worker an envelope owned by someone else.
            const master = newMaster();
            const transport = new InProcessMasterTransport(master, FAKE_TOKEN);
            const caller = new ScriptedCaller(['must never be produced']);
            const stack = makeStack(newRoot('foreign'), caller);
            const worker = makeWorker('worker-A', transport, stack);
            master.enqueue(inferenceJob('foreign'));
            master.forceNextClaimOwner('worker-OTHER');
            const outcome = await tick(worker);
            assert.deepEqual(outcome, { kind: 'claim_refused', job_id: 'job-foreign', reason: 'FOREIGN_OWNER' });
            assert.equal(caller.callCount, 0);
            assert.equal(stack.counts.dispatch + stack.counts.execute, 0);
            assert.equal(transport.calls.submitResult, 0);
        }
        {
            // 7d. Lease already expired when the claim arrives.
            const master = newMaster({ leaseMs: -1 });
            const transport = new InProcessMasterTransport(master, FAKE_TOKEN);
            const caller = new ScriptedCaller(['must never be produced']);
            const worker = makeWorker('worker-A', transport, makeStack(newRoot('expired'), caller));
            master.enqueue(inferenceJob('expired'));
            const outcome = await tick(worker);
            assert.deepEqual(outcome, { kind: 'claim_refused', job_id: 'job-expired', reason: 'LEASE_EXPIRED' });
            assert.equal(caller.callCount, 0);
            assert.equal(transport.calls.submitResult, 0);
        }

        // ------------------------------------------------------------------
        // 8. Interruption / reconnection over real HTTP on 127.0.0.1, plus a
        //    process restart that relies on the persisted ledger.
        // ------------------------------------------------------------------
        {
            const master = newMaster();
            let server = await startMockMasterServer(master);
            const port = server.port;
            const root = newRoot('http');
            const env = {
                VONE_MASTER_URL: server.url,
                VONE_WORKER_ID: 'worker-http',
                VONE_WORKER_TOKEN: FAKE_TOKEN,
                VONE_WORKER_ROOT: root,
                VONE_WORKER_TIMEOUT_MS: '2000',
            };
            const config = loadWorkerConfig(env);
            ledgerFiles.push(path.join(root, '.vone_worker_ledger.json'));

            try {
                // The Master goes away while the job is executing.
                const caller = new ScriptedCaller(['http-answer'], async () => {
                    await server.close();
                });
                const composed = createWorkerFromConfig(config, {
                    caller,
                    routes: [freeRoute()],
                    sleep: async () => {},
                    log: (event) => allLogs.push(event),
                    submitRetry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
                });
                master.enqueue(inferenceJob('http'));

                let outcome = await tick(composed.worker);
                assert.equal(outcome.kind, 'submit_deferred');
                assert.equal(outcome.kind === 'submit_deferred' && outcome.executed, true);
                const persisted = JSON.parse(fs.readFileSync(path.join(root, '.vone_worker_ledger.json'), 'utf8'));
                assert.equal(persisted.entries.length, 1);
                assert.equal(persisted.entries[0].state, 'COMPUTED');

                outcome = await tick(composed.worker);
                assert.equal(outcome.kind, 'master_unreachable');
                assert.equal(outcome.kind === 'master_unreachable' && outcome.phase, 'heartbeat');

                // run() backs off exponentially while the Master is down.
                const delays: number[] = [];
                const backoffWorker = createWorkerFromConfig(config, {
                    caller: new ScriptedCaller(['unused']),
                    routes: [freeRoute()],
                    sleep: async (ms) => {
                        delays.push(ms);
                    },
                    log: (event) => allLogs.push(event),
                }).worker;
                const downOutcomes = await backoffWorker.run({ maxTicks: 3, idleDelayMs: 10, maxBackoffMs: 25 });
                allOutcomes.push(...downOutcomes);
                assert.deepEqual(downOutcomes.map((o) => o.kind), ['master_unreachable', 'master_unreachable', 'master_unreachable']);
                assert.deepEqual(delays, [10, 20, 25]);

                // Master comes back on the same port: pending result is flushed,
                // not recomputed.
                server = await startMockMasterServer(master, port);
                outcome = await tick(composed.worker);
                assert.deepEqual(outcome, { kind: 'idle' });
                assert.equal(caller.callCount, 1);
                assert.equal(master.acceptedResults.length, 1);
                assert.equal(master.acceptedResults[0].replayed, true);
                assert.equal((master.acceptedResults[0].output as InferenceJobOutput).text, 'http-answer');
                assert.deepEqual(master.jobState('job-http'), { state: 'DONE', owner: 'worker-http' });

                // Process restart: a brand-new worker over the same root reloads
                // the ledger; a re-delivery of the same idempotency_key replays.
                master.redeliver('job-http');
                const freshCaller = new ScriptedCaller(['MUST-NOT-RUN-AFTER-RESTART']);
                const restarted = createWorkerFromConfig(config, {
                    caller: freshCaller,
                    routes: [freeRoute()],
                    sleep: async () => {},
                    log: (event) => allLogs.push(event),
                });
                outcome = await tick(restarted.worker);
                assert.equal(outcome.kind, 'completed');
                assert.equal(outcome.kind === 'completed' && outcome.executed, false);
                assert.equal(outcome.kind === 'completed' && outcome.replayed, true);
                assert.equal(freshCaller.callCount, 0);
                assert.equal(master.acceptedResults.length, 2);
                assert.equal((master.acceptedResults[1].output as InferenceJobOutput).text, 'http-answer');
                assert.equal(server.requests.missingContractHeader, 0);

                // Jobs ran in <root>/workspace; the ledger sits outside that sandbox.
                assert.equal(composed.sandbox.getProjectRoot(), fs.realpathSync(path.join(root, 'workspace')));
                assert.throws(() => composed.sandbox.resolveSafePath('../.vone_worker_ledger.json'), /SECURITY VIOLATION/);

                const reloaded = new SandboxResultLedger(new VOneVFSSandbox(root));
                assert.equal(reloaded.get('idem-http')?.state, 'SUBMITTED');
                assert.equal(reloaded.get('idem-http')?.master_checkpoint_revision, 2);
            } finally {
                await server.close();
            }
        }

        // ------------------------------------------------------------------
        // 9. Neither fake token ever appears in logs, outcomes, anything the
        //    Master received, or the persisted ledger.
        // ------------------------------------------------------------------
        {
            const haystacks = [
                JSON.stringify(allLogs),
                JSON.stringify(allOutcomes),
                ...allMasters.map((master) =>
                    JSON.stringify([master.heartbeats, master.claims, master.acceptedResults, master.duplicateResults, master.rejectedResults]),
                ),
                ...ledgerFiles.map((file) => fs.readFileSync(file, 'utf8')),
            ];
            assert.ok(allLogs.length > 10, 'expected worker logs to have been captured');
            for (const haystack of haystacks) {
                assert.ok(!haystack.includes(FAKE_TOKEN), 'FAKE_TOKEN leaked');
                assert.ok(!haystack.includes(WRONG_TOKEN), 'WRONG_TOKEN leaked');
            }
        }

        console.log('vone_master_worker: all assertions passed (local mock Master only - wire format unverified against the real Master)');
    } finally {
        fs.rmSync(tmpParent, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
