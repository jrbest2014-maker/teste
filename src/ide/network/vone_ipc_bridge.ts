import * as net from 'net';
import * as crypto from 'crypto';

export interface VOneIPCBridgeOptions {
    host?: string;
    port?: number;
    authToken?: string;
    maxMessageBytes?: number;
    idleTimeoutMs?: number;
}

type AuthMessage = { type: 'auth'; token: string };

export class VOneIPCBridge {
    private readonly server: net.Server;
    private readonly host: string;
    private readonly port: number;
    private readonly authToken: string;
    private readonly maxMessageBytes: number;
    private readonly idleTimeoutMs: number;

    constructor(options: VOneIPCBridgeOptions = {}) {
        this.host = options.host ?? '127.0.0.1';
        this.port = options.port ?? 11435;
        this.authToken = options.authToken ?? crypto.randomBytes(32).toString('hex');
        this.maxMessageBytes = options.maxMessageBytes ?? 64 * 1024;
        this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000;

        if (!this.isLoopbackHost(this.host)) {
            throw new Error(`[IPC SECURITY]: Refusing non-loopback host: ${this.host}`);
        }

        this.server = net.createServer((socket) => this.handleConnection(socket));
    }

    public getAuthToken(): string {
        return this.authToken;
    }

    public getAddress(): { host: string; port: number } {
        return { host: this.host, port: this.port };
    }

    public start(): Promise<void> {
        return new Promise((resolve, reject) => {
            const onError = (error: Error) => reject(error);
            this.server.once('error', onError);
            this.server.listen({ host: this.host, port: this.port, exclusive: true }, () => {
                this.server.off('error', onError);
                resolve();
            });
        });
    }

    public close(): Promise<void> {
        if (!this.server.listening) return Promise.resolve();
        return new Promise((resolve, reject) => {
            this.server.close((error) => error ? reject(error) : resolve());
        });
    }

    private handleConnection(socket: net.Socket): void {
        socket.setEncoding('utf8');
        socket.setTimeout(this.idleTimeoutMs, () => socket.destroy());

        let authenticated = false;
        let buffer = '';

        socket.on('data', (chunk: string) => {
            buffer += chunk;
            if (Buffer.byteLength(buffer, 'utf8') > this.maxMessageBytes) {
                this.send(socket, { ok: false, error: 'message_too_large' });
                socket.destroy();
                return;
            }

            let newlineIndex = buffer.indexOf('\n');
            while (newlineIndex >= 0) {
                const line = buffer.slice(0, newlineIndex).trim();
                buffer = buffer.slice(newlineIndex + 1);
                newlineIndex = buffer.indexOf('\n');
                if (!line) continue;

                let message: unknown;
                try {
                    message = JSON.parse(line);
                } catch {
                    this.send(socket, { ok: false, error: 'invalid_json' });
                    socket.destroy();
                    return;
                }

                if (!authenticated) {
                    if (!this.isValidAuthMessage(message)) {
                        this.send(socket, { ok: false, error: 'authentication_required' });
                        socket.destroy();
                        return;
                    }
                    authenticated = true;
                    this.send(socket, { ok: true, type: 'auth_ok' });
                    continue;
                }

                this.send(socket, { ok: true, type: 'message', payload: message });
            }
        });
    }

    private isValidAuthMessage(message: unknown): message is AuthMessage {
        if (!message || typeof message !== 'object') return false;
        const candidate = message as Partial<AuthMessage>;
        if (candidate.type !== 'auth' || typeof candidate.token !== 'string') return false;

        const expected = Buffer.from(this.authToken, 'utf8');
        const received = Buffer.from(candidate.token, 'utf8');
        return expected.length === received.length && crypto.timingSafeEqual(expected, received);
    }

    private send(socket: net.Socket, payload: unknown): void {
        if (!socket.destroyed) socket.write(`${JSON.stringify(payload)}\n`);
    }

    private isLoopbackHost(host: string): boolean {
        return host === '127.0.0.1' || host === '::1' || host === 'localhost';
    }
}
