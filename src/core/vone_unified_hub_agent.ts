import { VOneVFSSandbox } from './vone_vfs_sandbox';
import { VOneToolInterpreter } from './vone_tool_interpreter';
import { InferenceRequest, InferenceResult, ModelRouter } from '../server/vone_model_router';

export class VOneUnifiedHubAgent {
    private interpreter: VOneToolInterpreter;

    constructor(sandbox: VOneVFSSandbox, private readonly modelRouter?: ModelRouter) {
        this.interpreter = new VOneToolInterpreter(sandbox);
    }

    public async orchestrateExternalTool(type: string, params: any): Promise<string> {
        return await this.interpreter.dispatch(params);
    }

    public async askModel(request: InferenceRequest): Promise<InferenceResult> {
        if (!this.modelRouter) {
            throw new Error('[HUB ERROR]: No ModelRouter configured for this agent.');
        }
        return this.modelRouter.dispatch(request);
    }
}
