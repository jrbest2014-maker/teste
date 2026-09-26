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
    EXECUTION_CONTRACT_VERSION,
    R1_HTTP_PATHS,
    REQUIRED_GATES,
    SUPPORTED_CAPABILITIES,
    TransportError,
    WORKER_AUTH_MARKER,
    parseR1ClaimResponse,
    type BlockedJobOutput,
    type ClaimResponse,
    type ExecutorJobOutput,
    type HeartbeatResponse,
    type InferenceJobOutput,
    type JobEnvelope,
    type MasterTransport,
    type R1ResultBody,
    type R1ResultPayload,
    type ResultAck,
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
import { InProcessMasterTransport, MockMaster, startMockMasterServer, type MockJobSpec } from './testing/vone_mock_master';

/**
 * Executor-side tests for VONE_EXECUTION_CONTRACT_R1 over the Master's
 * VONE_WORKER_IDENTITY_R1 wire, against a LOCAL mock Master that speaks that
 * wire (in-process through the same adapters as HTTP, and real HTTP on
 * 127.0.0.1). No external network, no real credential: the tokens below are
 * obviously fake and the final block proves they never leak.
 */

const FAKE_TOKEN = 'FAKE-TEST-TOKEN-not-a-real-secret-0000';
const WRONG_TOKEN = 'FAKE-WRONG-TOKEN-not-a-real-secret-1111';
const NOT_OWNED = 'JOB_NOT_OWNED_OR_NOT_CLAIMED';

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

function newMaster(): MockMaster {
    const master = new MockMaster({ expectedToken: FAKE_TOKEN });
    allMasters.push(master);
    return master;
}

async function tick(worker: VOneMasterWorker): Promise<TickOutcome> {
    const outcome = await worker.runOnce();
    allOutcomes.push(outcome);
    return outcome;
}

function inferenceJob(id: string, args: Record<string, unknown> = { prompt: 'say hi', max_tokens: 64 }): MockJobSpec {
    return { id: `job-${id}`, toolName: 'vone_inference_execute', args };
}
function executorJob(id: string, objective = 'write the result file'): MockJobSpec {
    return { id: `job-${id}`, toolName: 'vone_executor_execute', args: { session_id: `session-${id}`, objective } };
}

/** The `result` of a DONE submission; fails the test if the body is an `error`. */
function resultOf(body: R1ResultBody | undefined): R1ResultPayload {
    assert.ok(body && 'result' in body, `expected a {jobId, workerId, result} body, got ${JSON.stringify(body)}`);
    return body.result;
}

/** The `error` text of a non-DONE submission; fails the test if the body is a `result`. */
function errorOf(body: R1ResultBody | undefined): string {
    assert.ok(body && 'error' in body, `expected a {jobId, workerId, error} body, got ${JSON.stringify(body)}`);
    return body.error;
}

/** Hands the worker one internal envelope directly - for guards the R1 adapter can never trigger. */
function internalTransport(job: JobEnvelope): MasterTransport & { submits: number } {
    const transport = {
        submits: 0,
        async heartbeat(): Promise<HeartbeatResponse> {
            return { ok: true, generation: null };
        },
        async claim(): Promise<ClaimResponse> {
            return { job };
        },
        async submitResult(): Promise<ResultAck> {
            transport.submits += 1;
            return { accepted: true };
        },
    };
    return transport;
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
        // 0. The R1 adapter reads only R1 fields: extra lease/owner/idempotency
        //    fields a Master might add are ignored, never trusted.
        // ------------------------------------------------------------------
        {
            const claimed = parseR1ClaimResponse(
                {
                    ok: true,
                    auth: WORKER_AUTH_MARKER,
                    job: {
                        id: 'job-x',
                        toolName: 'vone_inference_execute',
                        args: { prompt: 'p' },
                        createdAt: '2026-09-26T00:00:00Z',
                        worker_id: 'someone-else',
                        lease_id: 'forged-lease',
                        lease_expires_at: 0,
                        idempotency_key: 'forged-key',
                    },
                },
                'worker-A',
            );
            assert.deepEqual(claimed.job, {
                job_id: 'job-x',
                task_id: 'job-x',
                idempotency_key: 'job-x',
                capability: 'vone_inference_execute',
                worker_id: 'worker-A',
                lease_id: 'r1:job-x',
                lease_expires_at: Number.POSITIVE_INFINITY,
                payload: { prompt: 'p' },
            });
        }

        // ------------------------------------------------------------------
        // 1. Empty claim: heartbeat carries {workerId, version, statusPayload}
        //    with capabilities + strict gates; claim is {workerId}; nothing
        //    is executed and nothing is submitted.
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
            assert.deepEqual(master.heartbeats[0], {
                workerId: 'worker-A',
                version: EXECUTION_CONTRACT_VERSION,
                statusPayload: {
                    status: 'IDLE',
                    capabilities: ['vone_executor_execute', 'vone_inference_execute'],
                    pending_results: 0,
                    gates: REQUIRED_GATES,
                },
            });
            assert.deepEqual(master.heartbeats[0].statusPayload.capabilities, [...SUPPORTED_CAPABILITIES]);
            assert.deepEqual(master.claims, [{ workerId: 'worker-A' }]);
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
        // 2. Executor job -> VOneExecutor -> VOneAgentLoop -> {jobId, workerId,
        //    result} with evidence.
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
            const body = master.acceptedResults[0];
            assert.deepEqual(Object.keys(body).sort(), ['jobId', 'result', 'workerId']);
            assert.equal(body.jobId, 'job-exec-1');
            assert.equal(body.workerId, 'worker-A');
            const submitted = resultOf(body);
            assert.equal(submitted.status, 'DONE');
            assert.equal(submitted.contract, EXECUTION_CONTRACT_VERSION);
            assert.equal(submitted.idempotency_key, 'job-exec-1');
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
            const entry = ledger.get('job-exec-1');
            assert.equal(entry?.state, 'SUBMITTED');
            assert.equal(entry?.master_checkpoint_revision, null, 'R1 acks carry no revision');
        }

        // NO_EVIDENCE_NO_PASS: an executor run that finishes without producing
        // any artifact is DONE but HOLD, never PASS - and the result says so.
        {
            const master = newMaster();
            const caller = new ScriptedCaller(['{"action":"finish","summary":"claimed success, no evidence"}']);
            const stack = makeStack(newRoot('no-evidence'), caller);
            const worker = makeWorker('worker-A', new InProcessMasterTransport(master, FAKE_TOKEN), stack);
            master.enqueue(executorJob('exec-noevidence'));
            const outcome = await tick(worker);
            assert.equal(outcome.kind === 'completed' && outcome.status, 'DONE');
            assert.equal(outcome.kind === 'completed' && outcome.verdict, 'HOLD');
            const submitted = resultOf(master.acceptedResults[0]);
            assert.equal(submitted.evidence.verdict, 'HOLD');
            assert.equal(submitted.evidence.verdict_reason, 'NO_EVIDENCE');
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
            const output = resultOf(master.acceptedResults[0]).output as InferenceJobOutput;
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
        // block is reported as an `error` naming RoutingBlockedError.category,
        // with zero model calls - and nothing in the args can loosen a gate.
        {
            const cases: Array<{ name: string; routes: ModelRoute[]; args: Record<string, unknown>; category: string }> = [
                {
                    name: 'paid',
                    routes: [paidRoute()],
                    args: { prompt: 'spend', gates: { paid_blocked: 'UNLOCKED' }, allow_paid: true, route: 'PAID' },
                    category: 'paidBlocked',
                },
                { name: 'unknown-cost', routes: [unknownCostRoute()], args: { prompt: 'x' }, category: 'unknownCost' },
                {
                    name: 'physical',
                    routes: [freeRoute()],
                    args: { prompt: 'G1 X10', requires_physical_output: true, physical_output: 'UNLOCKED' },
                    category: 'physicalOutputLocked',
                },
            ];
            for (const testCase of cases) {
                const master = newMaster();
                const caller = new ScriptedCaller(['must never be produced']);
                const stack = makeStack(newRoot(`blocked-${testCase.name}`), caller, testCase.routes);
                const worker = makeWorker('worker-A', new InProcessMasterTransport(master, FAKE_TOKEN), stack);
                master.enqueue(inferenceJob(`blocked-${testCase.name}`, testCase.args));

                const outcome = await tick(worker);
                assert.equal(outcome.kind === 'completed' && outcome.status, 'BLOCKED', testCase.name);
                assert.equal(outcome.kind === 'completed' && outcome.verdict, 'BLOCKED', testCase.name);
                const error = errorOf(master.acceptedResults[0]);
                assert.match(error, /^BLOCKED verdict=BLOCKED/);
                assert.ok(error.includes(testCase.category), `${testCase.name}: ${error}`);
                assert.match(error, /output_sha256=[0-9a-f]{64}/);
                assert.equal(caller.callCount, 0, `${testCase.name}: model must not be called`);
            }

            // Same for the full executor path.
            const master = newMaster();
            const caller = new ScriptedCaller(['{"action":"finish","summary":"unreachable"}']);
            const stack = makeStack(newRoot('blocked-executor'), caller, [paidRoute()]);
            const worker = makeWorker('worker-A', new InProcessMasterTransport(master, FAKE_TOKEN), stack);
            master.enqueue(executorJob('blocked-exec'));
            const outcome = await tick(worker);
            assert.equal(outcome.kind === 'completed' && outcome.verdict, 'BLOCKED');
            const error = errorOf(master.acceptedResults[0]);
            assert.match(error, /agent_status=BLOCKED/);
            assert.match(error, /gates=paidBlocked/);
            assert.equal(caller.callCount, 0);
        }

        // ------------------------------------------------------------------
        // 4. Errors: unknown toolName, invalid args, execution error, malformed
        //    claim. Nothing unsupported/invalid is ever executed.
        // ------------------------------------------------------------------
        {
            const master = newMaster();
            const caller = new ScriptedCaller(['must never be produced']);
            const stack = makeStack(newRoot('errors'), caller);
            const worker = makeWorker('worker-A', new InProcessMasterTransport(master, FAKE_TOKEN), stack);

            master.enqueue({ ...inferenceJob('unknown-tool'), toolName: 'vone_shell_execute' });
            let outcome = await tick(worker);
            assert.equal(outcome.kind === 'completed' && outcome.status, 'REJECTED');
            assert.equal(outcome.kind === 'completed' && outcome.verdict, 'FAIL');
            let error = errorOf(master.acceptedResults[0]);
            assert.match(error, /^REJECTED verdict=FAIL/);
            assert.match(error, /UNSUPPORTED_CAPABILITY/);
            assert.match(error, /vone_shell_execute/);

            master.enqueue({ ...executorJob('bad-args'), args: { session_id: 's' } });
            outcome = await tick(worker);
            assert.equal(outcome.kind === 'completed' && outcome.status, 'REJECTED');
            error = errorOf(master.acceptedResults[1]);
            assert.match(error, /INVALID_PAYLOAD/);
            assert.match(error, /objective/);

            assert.equal(stack.counts.execute, 0);
            assert.equal(stack.counts.dispatch, 0);
            assert.equal(caller.callCount, 0);

            master.overrideNext('claim', { status: 200, body: { ok: true, auth: WORKER_AUTH_MARKER, job: { id: 'broken' } } });
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
            const error = errorOf(master.acceptedResults[0]);
            assert.match(error, /^FAILED verdict=FAIL/);
            assert.match(error, /EXECUTION_ERROR/);
            assert.match(error, /upstream exploded/);
            assert.match(error, /\[REDACTED\]/);
            assert.ok(!error.includes('sk-THISLOOKSLIKEASECRET'), 'secret-shaped text must be redacted');
            assert.equal(caller.callCount, 1);
        }

        // ------------------------------------------------------------------
        // 5. Idempotent retry (idempotency is keyed by the R1 job id).
        // ------------------------------------------------------------------
        {
            const master = newMaster();
            const transport = new InProcessMasterTransport(master, FAKE_TOKEN);
            const caller = new ScriptedCaller(['idempotent-answer']);
            const stack = makeStack(newRoot('idempotent'), caller);
            const ledger = new InMemoryResultLedger();
            const worker = makeWorker('worker-A', transport, stack, ledger);
            master.enqueue(inferenceJob('idem'));

            // 5a. The Master applied the result but the ack was lost. R1 has no
            //     duplicate ack: the retry hits a job that is no longer CLAIMED
            //     and gets 409. The job still ran exactly once and the worker
            //     neither retries again nor re-executes.
            transport.dropNextAcks = 1;
            let outcome = await tick(worker);
            assert.equal(outcome.kind, 'result_rejected');
            assert.equal(outcome.kind === 'result_rejected' && outcome.reason, NOT_OWNED);
            assert.equal(outcome.kind === 'result_rejected' && outcome.executed, true);
            assert.equal(transport.calls.submitResult, 2);
            assert.equal(master.acceptedResults.length, 1);
            assert.equal(master.rejectedResults.length, 1);
            assert.equal(caller.callCount, 1);
            assert.deepEqual(master.jobState('job-idem'), { state: 'DONE', owner: 'worker-A' });

            // 5b. The Master re-delivers the same job id: the stored result is
            //     resubmitted, nothing is re-executed.
            master.requeue('job-idem');
            outcome = await tick(worker);
            assert.equal(outcome.kind, 'completed');
            assert.equal(outcome.kind === 'completed' && outcome.executed, false);
            assert.equal(outcome.kind === 'completed' && outcome.replayed, true);
            assert.equal(caller.callCount, 1, 're-delivery must not re-run the model');
            assert.equal(stack.counts.dispatch, 1, 're-delivery must not re-dispatch');
            assert.equal(master.acceptedResults.length, 2);
            const [firstResult, replayedResult] = master.acceptedResults.map(resultOf);
            assert.equal(firstResult.replayed, false);
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

            // The exact request the transport sends: R1 path, Bearer auth,
            // Content-Type, and nothing else - no contract header.
            const seen: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
            const recordingFetch = (async (url: unknown, init?: RequestInit) => {
                seen.push({
                    url: String(url),
                    headers: Object.fromEntries(new Headers(init?.headers).entries()),
                    body: JSON.parse(String(init?.body)),
                });
                return new Response(JSON.stringify({ ok: true, job: null }), { status: 200 });
            }) as unknown as typeof fetch;
            const recording = new HttpMasterTransport({
                baseUrl: 'https://master.example.invalid/',
                credential: createWorkerCredential(FAKE_TOKEN),
                fetchImpl: recordingFetch,
            });
            const idle = await recording.claim({ contract: EXECUTION_CONTRACT_VERSION, worker_id: 'worker-A', capabilities: [] });
            assert.deepEqual(idle, { job: null });
            assert.equal(seen[0].url, `https://master.example.invalid${R1_HTTP_PATHS.claim}`);
            assert.deepEqual(Object.keys(seen[0].headers).sort(), ['authorization', 'content-type']);
            assert.equal(seen[0].headers.authorization, `Bearer ${FAKE_TOKEN}`);
            assert.deepEqual(seen[0].body, { workerId: 'worker-A' });

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
                () => echoTransport.claim({ contract: EXECUTION_CONTRACT_VERSION, worker_id: 'w', capabilities: [] }),
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
        // 6b. IDENTITY_R1 fail-closed: a response that does not prove this
        //     worker's identity stops it before anything runs.
        // ------------------------------------------------------------------
        {
            const identityCases: Array<{ name: string; route: 'heartbeat' | 'claim'; body: unknown }> = [
                { name: 'heartbeat for another worker', route: 'heartbeat', body: { ok: true, workerId: 'worker-Z', auth: WORKER_AUTH_MARKER, generation: 1 } },
                { name: 'heartbeat without IDENTITY_R1', route: 'heartbeat', body: { ok: true, workerId: 'worker-A', auth: 'NONE', generation: 1 } },
                {
                    name: 'claimed job without IDENTITY_R1',
                    route: 'claim',
                    body: { ok: true, job: { id: 'job-noauth', toolName: 'vone_inference_execute', args: { prompt: 'x' } } },
                },
            ];
            for (const testCase of identityCases) {
                const master = newMaster();
                const caller = new ScriptedCaller(['must never be produced']);
                const stack = makeStack(newRoot(`identity-${testCase.route}-${master.heartbeats.length}-${allMasters.length}`), caller);
                const transport = new InProcessMasterTransport(master, FAKE_TOKEN);
                const worker = makeWorker('worker-A', transport, stack);
                master.overrideNext(testCase.route, { status: 200, body: testCase.body });
                const outcomes = await worker.run({ maxTicks: 3, idleDelayMs: 1 });
                allOutcomes.push(...outcomes);
                assert.equal(outcomes.length, 1, `${testCase.name}: must stop`);
                assert.equal(outcomes[0].kind, 'auth_rejected', testCase.name);
                assert.equal(caller.callCount, 0, testCase.name);
                assert.equal(stack.counts.execute + stack.counts.dispatch, 0, testCase.name);
                assert.equal(transport.calls.submitResult, 0, testCase.name);
                if (testCase.route === 'heartbeat') assert.equal(transport.calls.claim, 0, `${testCase.name}: no claim`);
            }

            // ok:false on heartbeat is a protocol error, never a green light to claim.
            const master = newMaster();
            const transport = new InProcessMasterTransport(master, FAKE_TOKEN);
            const worker = makeWorker('worker-A', transport, makeStack(newRoot('heartbeat-not-ok'), new ScriptedCaller(['x'])));
            master.overrideNext('heartbeat', { status: 200, body: { ok: false, error: 'worker_disabled' } });
            const outcome = await tick(worker);
            assert.equal(outcome.kind, 'protocol_error');
            assert.equal(outcome.kind === 'protocol_error' && outcome.phase, 'heartbeat');
            assert.match(outcome.kind === 'protocol_error' ? outcome.error : '', /worker_disabled/);
            assert.equal(transport.calls.claim, 0);
        }

        // ------------------------------------------------------------------
        // 7. Ownership: the Master is the authority (HTTP 409).
        // ------------------------------------------------------------------
        {
            // 7a. The Master re-queues the job while worker A is executing it
            //     and worker B claims and completes it. A's late result gets
            //     409; A records it, does not retry and does not re-execute.
            const master = newMaster();
            const transportA = new InProcessMasterTransport(master, FAKE_TOKEN);
            const transportB = new InProcessMasterTransport(master, FAKE_TOKEN);
            const callerB = new ScriptedCaller(['answer-from-B']);
            const stackB = makeStack(newRoot('owner-B'), callerB);
            const workerB = makeWorker('worker-B', transportB, stackB);

            let outcomeB: TickOutcome | null = null;
            const callerA = new ScriptedCaller(['answer-from-A'], async () => {
                master.requeue('job-owned');
                outcomeB = await tick(workerB);
            });
            const stackA = makeStack(newRoot('owner-A'), callerA);
            const ledgerA = new InMemoryResultLedger();
            const workerA = makeWorker('worker-A', transportA, stackA, ledgerA);
            master.enqueue(inferenceJob('owned'));

            const outcome = await tick(workerA);
            const takeover = outcomeB as TickOutcome | null;
            assert.equal(takeover?.kind === 'completed' && takeover.executed, true, 'worker B must take the re-queued job');
            assert.equal(callerB.callCount, 1);
            assert.equal(outcome.kind, 'result_rejected');
            assert.equal(outcome.kind === 'result_rejected' && outcome.reason, NOT_OWNED);
            assert.equal(transportA.calls.submitResult, 1, 'an ownership rejection is not retried');
            assert.equal(ledgerA.get('job-owned')?.state, 'REJECTED_BY_MASTER');
            assert.equal(master.acceptedResults.length, 1);
            assert.equal(master.acceptedResults[0].workerId, 'worker-B');
            assert.equal((resultOf(master.acceptedResults[0]).output as InferenceJobOutput).text, 'answer-from-B');
            assert.equal(master.rejectedResults[0].workerId, 'worker-A');
            assert.deepEqual(master.jobState('job-owned'), { state: 'DONE', owner: 'worker-B' });

            const again = await tick(workerA);
            assert.deepEqual(again, { kind: 'idle' });
            assert.equal(transportA.calls.submitResult, 1, 'rejected result is not re-flushed');
            assert.equal(callerA.callCount, 1, 'rejected job is never re-executed');

            // 7b. Mock-level: a result in another worker's name, and one for a
            //     job nobody claimed, both get the R1 409 body.
            const forged = { ...master.acceptedResults[0], workerId: 'worker-A' };
            const forgedResponse = master.handleResult(FAKE_TOKEN, forged);
            assert.equal(forgedResponse.status, 409);
            assert.deepEqual(forgedResponse.body, { ok: false, error: 'job_not_owned_or_not_claimed' });
            const unclaimed = master.handleResult(FAKE_TOKEN, { jobId: 'job-never-claimed', workerId: 'worker-A', error: 'x' });
            assert.deepEqual(unclaimed, { status: 409, body: { ok: false, error: 'job_not_owned_or_not_claimed' } });
        }
        {
            // 7c. Worker-internal guards the R1 adapter can never trigger (it
            //     always sets the claimant as owner and no lease). Kept as
            //     defense in depth: an envelope owned by someone else, or with
            //     an expired lease, is refused before anything runs.
            const caller = new ScriptedCaller(['must never be produced']);
            const stack = makeStack(newRoot('internal-guards'), caller);
            const base: JobEnvelope = {
                job_id: 'job-guard',
                task_id: 'job-guard',
                idempotency_key: 'job-guard',
                capability: 'vone_inference_execute',
                worker_id: 'worker-A',
                lease_id: 'r1:job-guard',
                lease_expires_at: Number.POSITIVE_INFINITY,
                payload: { prompt: 'x' },
            };
            const foreign = internalTransport({ ...base, worker_id: 'worker-OTHER' });
            let outcome = await tick(makeWorker('worker-A', foreign, stack));
            assert.deepEqual(outcome, { kind: 'claim_refused', job_id: 'job-guard', reason: 'FOREIGN_OWNER' });
            const expired = internalTransport({ ...base, lease_expires_at: 0 });
            outcome = await tick(makeWorker('worker-A', expired, stack));
            assert.deepEqual(outcome, { kind: 'claim_refused', job_id: 'job-guard', reason: 'LEASE_EXPIRED' });
            assert.equal(caller.callCount, 0);
            assert.equal(stack.counts.dispatch + stack.counts.execute, 0);
            assert.equal(foreign.submits + expired.submits, 0);
        }

        // ------------------------------------------------------------------
        // 8. Interruption / reconnection over real HTTP on 127.0.0.1 (R1
        //    paths), plus a process restart that relies on the persisted ledger.
        // ------------------------------------------------------------------
        {
            const master = newMaster();
            let server = await startMockMasterServer(master);
            const port = server.port;
            const firstServer = server;
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
                const flushed = resultOf(master.acceptedResults[0]);
                assert.equal(flushed.replayed, true);
                assert.equal((flushed.output as InferenceJobOutput).text, 'http-answer');
                assert.deepEqual(master.jobState('job-http'), { state: 'DONE', owner: 'worker-http' });

                // Process restart: a brand-new worker over the same root reloads
                // the ledger; a re-delivery of the same job id replays.
                master.requeue('job-http');
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
                assert.equal((resultOf(master.acceptedResults[1]).output as InferenceJobOutput).text, 'http-answer');

                // Only R1 paths were ever hit, and never with the old contract header.
                const r1Paths = new Set<string>(Object.values(R1_HTTP_PATHS));
                for (const requests of [firstServer.requests, server.requests]) {
                    assert.ok(requests.paths.length > 0);
                    for (const hit of requests.paths) assert.ok(r1Paths.has(hit), `unexpected path ${hit}`);
                    assert.equal(requests.legacyContractHeader, 0);
                }

                // Jobs ran in <root>/workspace; the ledger sits outside that sandbox.
                assert.equal(composed.sandbox.getProjectRoot(), fs.realpathSync(path.join(root, 'workspace')));
                assert.throws(() => composed.sandbox.resolveSafePath('../.vone_worker_ledger.json'), /SECURITY VIOLATION/);

                const reloaded = new SandboxResultLedger(new VOneVFSSandbox(root));
                assert.equal(reloaded.get('job-http')?.state, 'SUBMITTED');
                assert.equal(reloaded.get('job-http')?.master_checkpoint_revision, null);
            } finally {
                await server.close();
            }
        }

        // ------------------------------------------------------------------
        // 9. No lease or contract-header assumption ever reaches the wire, and
        //    neither fake token appears in logs, outcomes, anything the Master
        //    received, or the persisted ledger.
        // ------------------------------------------------------------------
        {
            const wire = JSON.stringify(
                allMasters.map((master) => [master.heartbeats, master.claims, master.acceptedResults, master.rejectedResults]),
            );
            for (const legacy of ['lease_id', 'lease_expires_at', 'X-VOne-Contract', '/v1/execution', 'worker_id']) {
                assert.ok(!wire.includes(legacy), `"${legacy}" must not appear on the R1 wire`);
            }

            const haystacks = [
                JSON.stringify(allLogs),
                JSON.stringify(allOutcomes),
                wire,
                ...ledgerFiles.map((file) => fs.readFileSync(file, 'utf8')),
            ];
            assert.ok(allLogs.length > 10, 'expected worker logs to have been captured');
            for (const haystack of haystacks) {
                assert.ok(!haystack.includes(FAKE_TOKEN), 'FAKE_TOKEN leaked');
                assert.ok(!haystack.includes(WRONG_TOKEN), 'WRONG_TOKEN leaked');
            }
        }

        console.log('vone_master_worker: all assertions passed (R1 wire, local mock Master - not yet run against the live preview)');
    } finally {
        fs.rmSync(tmpParent, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
