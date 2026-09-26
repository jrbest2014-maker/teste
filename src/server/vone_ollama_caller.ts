import type { InferenceRequest, ModelCaller, ModelRoute } from './vone_model_router';

export interface OllamaCallerOptions {
    /** Loopback base URL of the local Ollama daemon (validated in vone_worker_config.ts). */
    readonly baseUrl: string;
    readonly timeoutMs?: number;
    readonly fetchImpl?: typeof fetch;
}

interface OllamaGenerateResponse {
    response?: unknown;
    done?: unknown;
    error?: unknown;
}

/**
 * Local inference through Ollama's `POST /api/generate` (non-streaming). No
 * credential is sent. Local compute has no per-token billing, so it reports
 * zero neurons against the router's free-tier budget.
 */
export class OllamaCaller implements ModelCaller {
    private readonly baseUrl: string;
    private readonly timeoutMs: number;
    private readonly fetchImpl: typeof fetch;

    constructor(options: OllamaCallerOptions) {
        this.baseUrl = options.baseUrl.replace(/\/+$/, '');
        this.timeoutMs = options.timeoutMs ?? 300_000;
        this.fetchImpl = options.fetchImpl ?? fetch;
    }

    public async run(route: ModelRoute, request: InferenceRequest): Promise<{ text: string; neuronsUsed: number }> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let response: Response;
        try {
            response = await this.fetchImpl(`${this.baseUrl}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: route.model,
                    prompt: request.prompt,
                    stream: false,
                    options: { num_predict: request.maxTokens ?? 512 },
                }),
                signal: controller.signal,
            });
        } catch (error) {
            const detail = controller.signal.aborted
                ? `timed out after ${this.timeoutMs}ms`
                : error instanceof Error
                  ? error.message
                  : String(error);
            throw new Error(`[OLLAMA ERROR]: ${detail}`);
        } finally {
            clearTimeout(timer);
        }

        const text = await response.text();
        if (!response.ok) {
            throw new Error(`[OLLAMA ERROR]: HTTP ${response.status} ${text.slice(0, 200)}`);
        }
        let payload: OllamaGenerateResponse;
        try {
            payload = JSON.parse(text) as OllamaGenerateResponse;
        } catch {
            throw new Error('[OLLAMA ERROR]: non-JSON response');
        }
        if (typeof payload.error === 'string') throw new Error(`[OLLAMA ERROR]: ${payload.error.slice(0, 200)}`);
        if (payload.done !== true || typeof payload.response !== 'string') {
            throw new Error('[OLLAMA ERROR]: response is not a completed generation');
        }
        return { text: payload.response, neuronsUsed: 0 };
    }
}
