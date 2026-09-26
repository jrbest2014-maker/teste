import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VOneVFSSandbox } from './vone_vfs_sandbox';
import { VOneHydrationEngine } from './vone_hydration_engine';
import { VOneSessionHydrationEngine } from './vone_session_hydration_engine';
import { VOneUnifiedHubAgent } from './vone_unified_hub_agent';
import { VOneAgentLoop } from './vone_agent_loop';
import {
    ModelRouter,
    createDefaultGates,
    type InferenceRequest,
    type ModelCaller,
    type ModelRoute,
} from '../server/vone_model_router';
import { loadWorkerConfig } from '../server/vone_worker_config';
import { createWorkerFromConfig } from '../server/vone_worker_factory';
import { InProcessMasterTransport, MockMaster } from '../server/testing/vone_mock_master';

const FAKE_TOKEN = 'FAKE-TEST-TOKEN-not-a-real-secret-0000';

class ScriptedCaller implements ModelCaller {
    public callCount = 0;
    private index = 0;
    constructor(private readonly responses: string[]) {}

    public async run(_route: ModelRoute, _request: InferenceRequest) {
        this.callCount += 1;
        const text = this.responses[Math.min(this.index, this.responses.length - 1)];
        this.index += 1;
        return { text, neuronsUsed: 1 };
    }
}

const freeRoute: ModelRoute = {
    id: 'session-free-route',
    tier: 'free',
    model: 'test-model',
    costPerMTokUsd: 0,
    state: 'FREE_AVAILABLE',
    neuronsUsedToday: 0,
};

const WRITE_A = '{"action":"tool","toolName":"write_file","arguments":{"path":"a.txt","content":"from-session-a"}}';
const FINISH = '{"action":"finish","summary":"done"}';

function loopOver(jobs: VOneVFSSandbox, hydration: VOneHydrationEngine, caller: ModelCaller, maxSteps: number): VOneAgentLoop {
    const hub = new VOneUnifiedHubAgent(jobs, new ModelRouter([{ ...freeRoute }], createDefaultGates(), caller));
    return new VOneAgentLoop(hub, hydration, { maxSteps });
}

/** Session A stops after one step, session B runs in between, then A resumes. */
async function interleave(jobs: VOneVFSSandbox, hydration: VOneHydrationEngine) {
    const first = await loopOver(jobs, hydration, new ScriptedCaller([WRITE_A]), 1).run('session-a', 'objective a');
    assert.equal(first.status, 'INCOMPLETE');
    const other = await loopOver(jobs, hydration, new ScriptedCaller([FINISH]), 5).run('session-b', 'objective b');
    assert.equal(other.status, 'DONE');
    const resumeCaller = new ScriptedCaller([FINISH]);
    const resumed = await loopOver(jobs, hydration, resumeCaller, 5).run('session-a', 'objective a');
    return { resumed, resumeCaller };
}

async function main(): Promise<void> {
    const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), 'vone-session-hydration-'));
    try {
        // 1. The base engine keeps one file per root, so session B overwrites
        //    session A and A silently restarts from scratch - the audit finding.
        {
            const root = fs.mkdtempSync(path.join(tmpParent, 'base-'));
            const jobs = new VOneVFSSandbox(root);
            const { resumed } = await interleave(jobs, new VOneHydrationEngine(jobs));
            assert.equal(resumed.stepsHistory.length, 1, 'base engine should have lost session A (documents the bug)');
            assert.equal(resumed.stepsHistory[0].decision?.action, 'finish');
        }

        // 2. Per-session files: A resumes from its own checkpoint, keeps its
        //    first step, asks the model only for the new step, and B is intact.
        {
            const root = fs.mkdtempSync(path.join(tmpParent, 'session-'));
            const jobs = new VOneVFSSandbox(root);
            const hydration = new VOneSessionHydrationEngine(jobs, 'sessions');
            const { resumed, resumeCaller } = await interleave(jobs, hydration);
            assert.equal(resumed.status, 'DONE');
            assert.equal(resumed.stepsHistory.length, 2);
            assert.equal(resumed.stepsHistory[0].decision?.action, 'tool');
            assert.equal(resumed.artifacts.length, 1);
            assert.equal(resumed.artifacts[0].path, 'a.txt');
            assert.equal(resumeCaller.callCount, 1);
            assert.equal(hydration.hydrate('session-b', 'x').status, 'DONE');
            assert.ok(!fs.existsSync(path.join(root, '.vone_agent_state.json')), 'per-session engine must not use the shared file');
        }

        // 3. Session ids are untrusted: they never become a path segment.
        {
            const root = fs.mkdtempSync(path.join(tmpParent, 'hostile-'));
            const sandbox = new VOneVFSSandbox(root);
            const hydration = new VOneSessionHydrationEngine(sandbox, 'sessions');
            const hostile = ['../../escape', '/etc/passwd', 'a/b/c', '..', ''];
            for (const sessionId of hostile) {
                hydration.dehydrate({ sessionId, currentObjective: 'x', stepsHistory: [], status: 'IDLE' });
                assert.equal(hydration.hydrate(sessionId, 'x').sessionId, sessionId);
            }
            assert.deepEqual(fs.readdirSync(root), ['sessions']);
            const files = fs.readdirSync(path.join(root, 'sessions'));
            assert.equal(files.length, hostile.length);
            for (const file of files) assert.match(file, /^[0-9a-f]{64}\.json$/);
            assert.ok(!fs.existsSync(path.join(tmpParent, 'escape')));
        }

        // 4. A corrupted checkpoint falls back to a fresh state instead of throwing.
        {
            const root = fs.mkdtempSync(path.join(tmpParent, 'corrupt-'));
            const sandbox = new VOneVFSSandbox(root);
            const hydration = new VOneSessionHydrationEngine(sandbox, 'sessions');
            hydration.dehydrate({ sessionId: 's', currentObjective: 'x', stepsHistory: [], status: 'DONE' });
            const [file] = fs.readdirSync(path.join(root, 'sessions'));
            fs.writeFileSync(path.join(root, 'sessions', file), '{not json');
            assert.equal(hydration.hydrate('s', 'fresh').status, 'IDLE');
            assert.equal(hydration.hydrate('s', 'fresh').currentObjective, 'fresh');
        }

        // 5. The real factory wires it in: checkpoints land in <root>/sessions,
        //    outside the job sandbox, where no agent tool can reach them.
        {
            const root = fs.mkdtempSync(path.join(tmpParent, 'factory-'));
            const config = loadWorkerConfig({
                VONE_MASTER_URL: 'https://master.example.invalid',
                VONE_WORKER_ID: 'worker-session',
                VONE_WORKER_TOKEN: FAKE_TOKEN,
                VONE_WORKER_ROOT: root,
            });
            const master = new MockMaster({ expectedToken: FAKE_TOKEN });
            const composed = createWorkerFromConfig(config, {
                caller: new ScriptedCaller([
                    '{"action":"tool","toolName":"write_file","arguments":{"path":"result.txt","content":"evidence"}}',
                    FINISH,
                ]),
                routes: [{ ...freeRoute }],
                transport: new InProcessMasterTransport(master, FAKE_TOKEN),
                sleep: async () => {},
                log: () => {},
            });
            master.enqueue({
                job_id: 'job-s',
                task_id: 'task-s',
                idempotency_key: 'idem-s',
                capability: 'vone_executor_execute',
                payload: { session_id: 'session-factory', objective: 'write the result file' },
            });

            const outcome = await composed.worker.runOnce();
            assert.equal(outcome.kind, 'completed');
            assert.equal(fs.readdirSync(path.join(root, 'sessions')).length, 1);
            assert.ok(!fs.existsSync(path.join(root, 'workspace', '.vone_agent_state.json')));
            assert.throws(() => composed.sandbox.resolveSafePath('../sessions/anything.json'), /SECURITY VIOLATION/);
        }

        console.log('vone_session_hydration_engine: all assertions passed');
    } finally {
        fs.rmSync(tmpParent, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
