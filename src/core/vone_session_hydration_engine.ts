import { createHash } from 'node:crypto';
import path from 'node:path';
import { VOneVFSSandbox } from './vone_vfs_sandbox';
import { VOneHydrationEngine } from './vone_hydration_engine';

/**
 * One checkpoint file per session instead of the base engine's single
 * `.vone_agent_state.json`, which lets a second session overwrite the
 * first so it can never resume. File names are the sha256 of the session
 * id: session ids arrive from the Master (untrusted), so they never become
 * a path segment. Hand it a sandbox the agent's tools cannot reach, or a
 * job could rewrite its own checkpoint.
 */
export class VOneSessionHydrationEngine extends VOneHydrationEngine {
    constructor(
        private readonly stateSandbox: VOneVFSSandbox,
        private readonly directory = 'sessions',
    ) {
        super(stateSandbox);
    }

    public override dehydrate(state: any): void {
        this.stateSandbox.writeFile(this.fileFor(String(state.sessionId)), JSON.stringify(state, null, 2));
    }

    public override hydrate(sessionId: string, defaultObj: string): any {
        try {
            const data = JSON.parse(this.stateSandbox.readFile(this.fileFor(sessionId)));
            if (data.sessionId === sessionId) return data;
        } catch {}
        return { sessionId, currentObjective: defaultObj, stepsHistory: [], status: 'IDLE' };
    }

    private fileFor(sessionId: string): string {
        const digest = createHash('sha256').update(sessionId, 'utf8').digest('hex');
        return path.join(this.directory, `${digest}.json`);
    }
}
