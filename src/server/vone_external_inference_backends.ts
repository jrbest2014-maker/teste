import { InferenceBackend, InferenceBackendResult } from './vone_inference_failover_executor';

export class ExternalInferencePolicyError extends Error {
  constructor(public readonly code: 'MISSING_KEY' | 'FREE_TIER_NOT_VERIFIED' | 'FREE_MODEL_NOT_VERIFIED' | 'REMOTE_FAILED', message: string) {
    super(message);
    this.name = 'ExternalInferencePolicyError';
  }
}

export class OpenRouterFreeInferenceBackend implements InferenceBackend {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly model: string,
    private readonly verifyFreeModel: (model: string) => Promise<boolean>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async run(prompt: string, maxTokens: number): Promise<InferenceBackendResult> {
    if (!this.apiKey || this.apiKey.length < 20) throw new ExternalInferencePolicyError('MISSING_KEY', 'OpenRouter key unavailable');
    if (!(await this.verifyFreeModel(this.model))) throw new ExternalInferencePolicyError('FREE_MODEL_NOT_VERIFIED', 'OpenRouter model is not verified zero-price at dispatch time');
    const response = await this.fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens }),
    });
    const text = await response.text();
    if (!response.ok) throw new ExternalInferencePolicyError('REMOTE_FAILED', 'OpenRouter inference failed: HTTP ' + response.status);
    let payload: any;
    try { payload = JSON.parse(text); } catch { throw new ExternalInferencePolicyError('REMOTE_FAILED', 'OpenRouter returned invalid JSON'); }
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new ExternalInferencePolicyError('REMOTE_FAILED', 'OpenRouter response contract invalid');
    return { text: content, model: String(payload?.model || this.model) };
  }
}

export class GroqFreeInferenceBackend implements InferenceBackend {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly freeTierVerified: boolean,
    private readonly model = 'openai/gpt-oss-120b',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async run(prompt: string, maxTokens: number): Promise<InferenceBackendResult> {
    if (!this.apiKey || this.apiKey.length < 20) throw new ExternalInferencePolicyError('MISSING_KEY', 'Groq key unavailable');
    if (!this.freeTierVerified) throw new ExternalInferencePolicyError('FREE_TIER_NOT_VERIFIED', 'Groq Free tier is not verified; paid execution remains blocked');
    const response = await this.fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens }),
    });
    const text = await response.text();
    if (!response.ok) throw new ExternalInferencePolicyError('REMOTE_FAILED', 'Groq inference failed: HTTP ' + response.status);
    let payload: any;
    try { payload = JSON.parse(text); } catch { throw new ExternalInferencePolicyError('REMOTE_FAILED', 'Groq returned invalid JSON'); }
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new ExternalInferencePolicyError('REMOTE_FAILED', 'Groq response contract invalid');
    return { text: content, model: String(payload?.model || this.model) };
  }
}
