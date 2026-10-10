import * as http from 'node:http';
import * as crypto from 'node:crypto';
import type { VOneInferenceFailoverExecutor } from './vone_inference_failover_executor';
import type { InferenceCapacity } from './vone_cloud_inference_policy';

export interface VOneLocalChatServerOptions {
    readonly host?: string;
    readonly port?: number;
    readonly authToken?: string;
    readonly maxBodyBytes?: number;
}

/**
 * Servidor HTTP local (loopback-only) que expõe o
 * VOneInferenceFailoverExecutor já existente diretamente pra clientes na
 * mesma máquina - sem passar pela fila de jobs do Master (Cloudflare D1).
 *
 * Existe porque o /vone-mobile real (fora deste repositório, Quick Edit da
 * Cloudflare) só sabe falar com a rota CLOUD_ONLY do Master: quando o D1
 * do Master trava (confirmado ao vivo em 2026-10-10: cota diária de
 * escrita do tier grátis excedida), o app inteiro cai pra OFFLINE mesmo
 * com Ollama local saudável - porque até despachar um job local passa
 * pelo D1. O failover cloud->desktop já implementado em
 * vone_inference_failover_executor.ts nunca chega a rodar nesse caminho,
 * porque o job nunca é criado.
 *
 * Este servidor é o atalho: chama o executor em processo, sem fila, sem
 * D1. Fica ONLINE enquanto o processo do worker próprio estiver de pé,
 * independente do estado do Master na nuvem. Não substitui o /vone-mobile
 * real (que não está neste repositório, não dá pra editar daqui) - serve
 * clientes locais como o apps/vone-studio.
 */
export class VOneLocalChatServer {
    private readonly server: http.Server;
    private readonly host: string;
    private readonly port: number;
    private readonly authToken: string;
    private readonly maxBodyBytes: number;

    constructor(
        private readonly executor: Pick<VOneInferenceFailoverExecutor, 'execute'>,
        options: VOneLocalChatServerOptions = {},
    ) {
        this.host = options.host ?? '127.0.0.1';
        this.port = options.port ?? 8787;
        this.authToken = options.authToken ?? crypto.randomBytes(32).toString('hex');
        this.maxBodyBytes = options.maxBodyBytes ?? 64 * 1024;

        if (!this.isLoopbackHost(this.host)) {
            throw new Error(`[LOCAL CHAT SECURITY]: Refusing non-loopback host: ${this.host}`);
        }

        this.server = http.createServer((req, res) => this.handle(req, res));
    }

    public getAuthToken(): string {
        return this.authToken;
    }

    public getAddress(): { host: string; port: number } {
        const bound = this.server.address();
        if (bound && typeof bound === 'object') return { host: this.host, port: bound.port };
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
            this.server.close((error) => (error ? reject(error) : resolve()));
        });
    }

    private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        if (req.method === 'GET' && req.url === '/health') {
            this.json(res, 200, { ok: true, service: 'vone-local-chat' });
            return;
        }

        if (req.method === 'POST' && req.url === '/chat') {
            this.handleChat(req, res);
            return;
        }

        this.json(res, 404, { error: 'not_found' });
    }

    private handleChat(req: http.IncomingMessage, res: http.ServerResponse): void {
        if (!this.isAuthorized(req)) {
            this.json(res, 401, { error: 'unauthorized' });
            return;
        }

        let body = '';
        let tooLarge = false;
        req.on('data', (chunk: Buffer) => {
            body += chunk.toString('utf8');
            if (Buffer.byteLength(body, 'utf8') > this.maxBodyBytes) {
                tooLarge = true;
                req.destroy();
            }
        });
        req.on('end', () => {
            if (tooLarge) {
                this.json(res, 413, { error: 'payload_too_large' });
                return;
            }
            let parsed: unknown;
            try {
                parsed = JSON.parse(body);
            } catch {
                this.json(res, 400, { error: 'invalid_json' });
                return;
            }
            const prompt = this.extractPrompt(parsed);
            if (!prompt) {
                this.json(res, 400, { error: 'prompt_required' });
                return;
            }
            const maxTokens = this.extractMaxTokens(parsed);
            const capacity: InferenceCapacity = { cloud: 'FREE_AVAILABLE', desktop: 'ONLINE' };

            this.executor
                .execute({ prompt, maxTokens, estimatedNeurons: Math.max(1, Math.ceil(maxTokens / 100)), capacity })
                .then((result) => {
                    this.json(res, result.status === 'DONE' ? 200 : 503, {
                        status: result.status,
                        target: result.target,
                        reason: result.reason,
                        text: result.text,
                        model: result.model,
                        neurons: result.neurons,
                    });
                })
                .catch((error: unknown) => {
                    this.json(res, 500, {
                        error: 'inference_failed',
                        message: error instanceof Error ? error.message : String(error),
                    });
                });
        });
    }

    private isAuthorized(req: http.IncomingMessage): boolean {
        const header = req.headers.authorization;
        if (!header || !header.startsWith('Bearer ')) return false;
        const token = header.slice('Bearer '.length);
        const expected = Buffer.from(this.authToken, 'utf8');
        const received = Buffer.from(token, 'utf8');
        return expected.length === received.length && crypto.timingSafeEqual(expected, received);
    }

    private extractPrompt(value: unknown): string | null {
        if (!value || typeof value !== 'object') return null;
        const prompt = (value as Record<string, unknown>).prompt;
        return typeof prompt === 'string' && prompt.trim().length > 0 ? prompt : null;
    }

    private extractMaxTokens(value: unknown): number {
        if (!value || typeof value !== 'object') return 512;
        const raw = (value as Record<string, unknown>).max_tokens;
        return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.min(raw, 2048) : 512;
    }

    private json(res: http.ServerResponse, status: number, body: unknown): void {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(body));
    }

    private isLoopbackHost(host: string): boolean {
        return host === '127.0.0.1' || host === '::1' || host === 'localhost';
    }
}
