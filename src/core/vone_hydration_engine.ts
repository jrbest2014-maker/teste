import { VOneVFSSandbox } from './vone_vfs_sandbox';

export class VOneHydrationEngine {
    constructor(private sandbox: VOneVFSSandbox) {}

    public dehydrate(state: any): void {
        this.sandbox.writeFile('.vone_agent_state.json', JSON.stringify(state, null, 2));
    }

    public hydrate(sessionId: string, defaultObj: string): any {
        try {
            const data = JSON.parse(this.sandbox.readFile('.vone_agent_state.json'));
            if (data.sessionId === sessionId) return data;
        } catch (e) {}
        return { sessionId, currentObjective: defaultObj, stepsHistory: [], status: 'IDLE' };
    }
}