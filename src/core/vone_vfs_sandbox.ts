import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';

const MAX_COMMAND_OUTPUT = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;

type AllowedCommand = { executable: string; args: string[] };

export class VOneVFSSandbox {
    private readonly projectRoot: string;
    private readonly commandWhitelist: Map<string, AllowedCommand> = new Map([
        ['npm test', { executable: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['test'] }],
        ['pytest', { executable: process.platform === 'win32' ? 'pytest.exe' : 'pytest', args: [] }],
        ['git status', { executable: 'git', args: ['status'] }],
        ['git diff', { executable: 'git', args: ['diff'] }],
        ['ls', { executable: process.platform === 'win32' ? 'cmd.exe' : 'ls', args: process.platform === 'win32' ? ['/c', 'dir'] : [] }],
        ['pwd', { executable: process.platform === 'win32' ? 'cmd.exe' : 'pwd', args: process.platform === 'win32' ? ['/c', 'cd'] : [] }],
    ]);

    constructor(customRoot?: string) {
        const requestedRoot = path.resolve(customRoot || process.cwd());
        if (!fs.existsSync(requestedRoot)) {
            throw new Error(`[VFS ERROR]: Project root does not exist: ${requestedRoot}`);
        }
        if (!fs.statSync(requestedRoot).isDirectory()) {
            throw new Error(`[VFS ERROR]: Project root is not a directory: ${requestedRoot}`);
        }
        this.projectRoot = fs.realpathSync.native(requestedRoot);
    }

    public getProjectRoot(): string {
        return this.projectRoot;
    }

    public resolveSafePath(unsafePath: string): string {
        if (!unsafePath || unsafePath.includes('\0')) {
            throw new Error('[SECURITY VIOLATION]: Invalid path.');
        }

        const lexicalTarget = path.resolve(this.projectRoot, unsafePath);
        this.assertWithinRoot(lexicalTarget, unsafePath);

        const nearestExisting = this.findNearestExistingAncestor(lexicalTarget);
        const realAncestor = fs.realpathSync.native(nearestExisting);
        this.assertWithinRoot(realAncestor, unsafePath);

        if (fs.existsSync(lexicalTarget)) {
            const realTarget = fs.realpathSync.native(lexicalTarget);
            this.assertWithinRoot(realTarget, unsafePath);
            return realTarget;
        }

        const suffix = path.relative(nearestExisting, lexicalTarget);
        const reconstructed = path.resolve(realAncestor, suffix);
        this.assertWithinRoot(reconstructed, unsafePath);
        return reconstructed;
    }

    public readFile(relativePath: string): string {
        const safePath = this.resolveSafePath(relativePath);
        if (!fs.existsSync(safePath)) return '';
        const stat = fs.statSync(safePath);
        if (!stat.isFile()) {
            throw new Error(`[VFS ERROR]: Path is not a file: ${relativePath}`);
        }
        return fs.readFileSync(safePath, 'utf-8');
    }

    public writeFile(relativePath: string, content: string): void {
        const safePath = this.resolveSafePath(relativePath);
        const dir = path.dirname(safePath);
        fs.mkdirSync(dir, { recursive: true });

        const verifiedDir = fs.realpathSync.native(dir);
        this.assertWithinRoot(verifiedDir, relativePath);

        const tempPath = path.join(verifiedDir, `.${path.basename(safePath)}.${process.pid}.${Date.now()}.tmp`);
        try {
            fs.writeFileSync(tempPath, content, { encoding: 'utf-8', flag: 'wx' });
            fs.renameSync(tempPath, safePath);
        } finally {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        }
    }

    public async executeTerminalCommand(commandString: string): Promise<string> {
        const trimmedCommand = commandString.trim();
        const allowed = this.commandWhitelist.get(trimmedCommand);
        if (!allowed) {
            throw new Error(`[BLOCKED]: Command "${trimmedCommand}" requires human approval.`);
        }

        return new Promise((resolve, reject) => {
            execFile(
                allowed.executable,
                allowed.args,
                {
                    cwd: this.projectRoot,
                    shell: false,
                    timeout: COMMAND_TIMEOUT_MS,
                    maxBuffer: MAX_COMMAND_OUTPUT,
                    windowsHide: true,
                },
                (error, stdout, stderr) => {
                    if (error) {
                        reject(new Error(String(stderr || error.message)));
                        return;
                    }
                    resolve(stdout);
                },
            );
        });
    }

    private assertWithinRoot(candidatePath: string, originalInput: string): void {
        const relative = path.relative(this.projectRoot, candidatePath);
        const escapes = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
        if (escapes) {
            throw new Error(`[SECURITY VIOLATION]: Workspace escape detected: ${originalInput}`);
        }
    }

    private findNearestExistingAncestor(candidatePath: string): string {
        let current = candidatePath;
        while (!fs.existsSync(current)) {
            const parent = path.dirname(current);
            if (parent === current) {
                throw new Error(`[VFS ERROR]: Could not resolve ancestor for ${candidatePath}`);
            }
            current = parent;
        }
        return current;
    }
}
