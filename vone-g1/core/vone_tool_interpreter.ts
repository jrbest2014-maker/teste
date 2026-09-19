import { VOneVFSSandbox } from './vone_vfs_sandbox';

export class VOneToolInterpreter {
    constructor(private sandbox: VOneVFSSandbox) {}
    public async dispatch(payload: any): Promise<string> {
        try {
            if (payload.toolName === 'read_file') return this.sandbox.readFile(payload.arguments.path);
            if (payload.toolName === 'write_file') {
                this.sandbox.writeFile(payload.arguments.path, payload.arguments.content);
                return '[SUCCESS]';
            }
            if (payload.toolName === 'execute_command') return await this.sandbox.executeTerminalCommand(payload.arguments.command);
        } catch (e: any) { return `[ERROR]: ${e.message}`; }
        return 'Unknown Tool';
    }
}