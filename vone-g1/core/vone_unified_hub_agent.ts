import { VOneVFSSandbox } from './vone_vfs_sandbox';
import { VOneToolInterpreter } from './vone_tool_interpreter';

export class VOneUnifiedHubAgent {
    private interpreter: VOneToolInterpreter;
    constructor(sandbox: VOneVFSSandbox) { this.interpreter = new VOneToolInterpreter(sandbox); }
    public async orchestrateExternalTool(type: string, params: any): Promise<string> {
        return await this.interpreter.dispatch(params);
    }
}