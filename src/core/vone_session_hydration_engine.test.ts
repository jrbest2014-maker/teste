import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VOneVFSSandbox } from './vone_vfs_sandbox';
import { VOneHydrationEngine } from './vone_hydration_engine';
import { VOneSessionHydrationEngine, resolveExecutorStateRoot } from './vone_session_hydration_engine';
import { VOneUnifiedHubAgent } from './vone_unified_hub_agent';
import { VOneExecutor } from '../server/vone_executor';
import { ModelRouter, createDefaultGates, type InferenceRequest, type ModelCaller, type ModelRoute } from '../server/vone_model_router';

class ScriptedCaller implements ModelCaller {
    public callCount = 0;
    constructor(private readonly responses: string[]) {}
    public async run(_route: ModelRoute, _request: InferenceRequest) {
        const text = this.responses[Math.min(this.callCount, this.responses.length - 1)];
        this.callCount += 1;
        return { text, neuronsUsed: 1 };
    }
}

const route: ModelRoute = { id: 'free', tier: 'free', model: 'm', costPerMTokUsd: 0, state: 'FREE_AVAILABLE', neuronsUsedToday: 0 };
const write = (content: string) => `{"action":"tool","toolName":"write_file","arguments":{"path":"out.txt","content":"${content}"}}`;
const FINISH = '{"action":"finish","summary":"ok"}';

function executorOver(jobs: VOneVFSSandbox, hydration: VOneHydrationEngine, caller: ModelCaller): VOneExecutor {
    return new VOneExecutor(new VOneUnifiedHubAgent(jobs, new ModelRouter([{ ...route }], createDefaultGates(), caller)), hydration);
}

/** Job A completes, job B runs, then the Master re-delivers job A (e.g. its result ack was lost). */
async function redeliverAfterAnotherJob(jobs: VOneVFSSandbox, hydration: VOneHydrationEngine) {
    await executorOver(jobs, hydration, new ScriptedCaller([write('A'), FINISH])).execute({ sessionId: 'job-A', objective: 'a' });
    await executorOver(jobs, hydration, new ScriptedCaller([write('B'), FINISH])).execute({ sessionId: 'job-B', objective: 'b' });
    const redelivery = new ScriptedCaller([write('A-again'), FINISH]);
    const result = await executorOver(jobs, hydration, redelivery).execute({ sessionId: 'job-A', objective: 'a' });
    return { result, redelivery };
}

async function main(): Promise<void> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vone-session-hydration-'));
    const dir = (name: string) => {
        const d = path.join(tmp, name);
        fs.mkdirSync(d, { recursive: true });
        return d;
    };
    try {
        // 1. The single shared state file: B overwrites A, so the re-delivered A runs again
        //    (documents the bug this engine fixes).
        {
            const jobs = new VOneVFSSandbox(dir('base'));
            const { redelivery } = await redeliverAfterAnotherJob(jobs, new VOneHydrationEngine(jobs));
            assert.equal(redelivery.callCount, 2, 'base engine re-executes the re-delivered job');
            assert.equal(jobs.readFile('out.txt'), 'A-again');
        }

        // 2. Per-session checkpoints outside the job sandbox: the re-delivered A finds its own
        //    DONE checkpoint and returns it - zero model calls, no side effect repeated.
        {
            const jobs = new VOneVFSSandbox(dir('fixed/project'));
            const hydration = new VOneSessionHydrationEngine(new VOneVFSSandbox(dir('fixed/state')), 'sessions');
            const { result, redelivery } = await redeliverAfterAnotherJob(jobs, hydration);
            assert.equal(result.state.status, 'DONE');
            assert.equal(redelivery.callCount, 0, 're-delivery must not re-execute');
            assert.equal(jobs.readFile('out.txt'), 'B', 'A must not write again');
            assert.equal(hydration.hydrate('job-B', 'x').status, 'DONE');

            // The agent's tools are confined to the project root: they cannot reach the state dir,
            // and writing the old state file name inside the project changes nothing.
            assert.throws(() => jobs.resolveSafePath('../state/sessions/x.json'), /SECURITY VIOLATION/);
            const tamper = new ScriptedCaller(['{"action":"tool","toolName":"write_file","arguments":{"path":".vone_agent_state.json","content":"{}"}}', FINISH]);
            await executorOver(jobs, hydration, tamper).execute({ sessionId: 'job-C', objective: 'c' });
            assert.equal(hydration.hydrate('job-A', 'x').status, 'DONE', 'checkpoints unaffected by agent writes');
        }

        // 3. Session ids come from the Master: they never become a path segment.
        {
            const root = dir('hostile');
            const hydration = new VOneSessionHydrationEngine(new VOneVFSSandbox(root), 'sessions');
            const hostile = ['../../escape', '/etc/passwd', 'a/b/c', '..', ''];
            for (const sessionId of hostile) {
                hydration.dehydrate({ sessionId, currentObjective: 'x', stepsHistory: [], status: 'IDLE' });
                assert.equal(hydration.hydrate(sessionId, 'x').sessionId, sessionId);
            }
            assert.deepEqual(fs.readdirSync(root), ['sessions']);
            for (const file of fs.readdirSync(path.join(root, 'sessions'))) assert.match(file, /^[0-9a-f]{64}\.json$/);
            assert.ok(!fs.existsSync(path.join(tmp, 'escape')));
        }

        // 4. A corrupted checkpoint falls back to a fresh state instead of throwing.
        {
            const root = dir('corrupt');
            const hydration = new VOneSessionHydrationEngine(new VOneVFSSandbox(root), 'sessions');
            hydration.dehydrate({ sessionId: 's', currentObjective: 'x', stepsHistory: [], status: 'DONE' });
            const [file] = fs.readdirSync(path.join(root, 'sessions'));
            fs.writeFileSync(path.join(root, 'sessions', file), '{not json');
            assert.equal(hydration.hydrate('s', 'fresh').status, 'IDLE');
        }

        // 5. The state root must be outside the project root.
        {
            const project = path.join(tmp, 'p');
            // resolveExecutorStateRoot path.resolve()s its result (so later path.relative
            // comparisons are unambiguous) - the expected value must too, or this only
            // passes by accident on POSIX, where resolve() of an already-absolute path is
            // a no-op. On Windows, resolve() prepends the current drive letter to a
            // drive-relative input like "\home\u\...", which is exactly what should happen.
            assert.equal(
                resolveExecutorStateRoot(project, 'W 1/x', undefined, '/home/u'),
                path.resolve(path.join('/home/u', '.vone', 'state', 'W_1_x')),
            );
            assert.equal(resolveExecutorStateRoot(project, 'w', path.join(tmp, 'state'), '/home/u'), path.join(tmp, 'state'));
            for (const inside of [project, path.join(project, '.vone-state'), path.join(project, 'a', '..', 'b')]) {
                assert.throws(() => resolveExecutorStateRoot(project, 'w', inside, '/home/u'), /must_be_outside/);
            }
            assert.equal(resolveExecutorStateRoot(project, 'w', `${project}-state`, '/home/u'), `${project}-state`);
        }

        console.log('vone_session_hydration_engine: all assertions passed');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
