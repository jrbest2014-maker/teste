import type { InferenceRequest, ModelCaller, ModelRoute } from './vone_model_router';

export interface OllamaCallerOptions {
    readonly baseUrl?: string;
    readonly fetchImpl?: typeof fetch;
}

export class OllamaModelCaller implements ModelCaller {
    private readonly baseUrl: string;
    private readonly fetchImpl: typeof fetch;

    constructor(options: OllamaCallerOptions = {}) {
        this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
        this.fetchImpl = options.fetchImpl ?? fetch;
    }

    public async run(route: ModelRoute, request: InferenceRequest): Promise<{ text: string; neuronsUsed: number }> {
        const response = await this.fetchImpl(this.baseUrl + '/api/generate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: route.model,
                prompt: request.prompt,
                stream: false,
                options: { num_predict: request.maxTokens ?? 512 },
            }),
            signal: AbortSignal.timeout(120_000),
        });
        if (!response.ok) {
            throw new Error(`ollama_http_${response.status}: ${(await response.text()).slice(0, 1000)}`);
        }
        const payload = await response.json() as { response?: string };
        if (!payload.response) throw new Error('ollama_empty_response');
        return {
            text: payload.response,
            neuronsUsed: Math.max(1, Math.ceil((request.maxTokens ?? 512) / 100)),
        };
    }
}
