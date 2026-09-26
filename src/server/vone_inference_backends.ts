import { classifyCloudflareFailure, CloudInferenceBlockedError } from './vone_cloud_inference_policy';
import { InferenceBackend, InferenceBackendResult } from './vone_inference_failover_executor';

export class CloudflareInferenceBackend implements InferenceBackend {
  constructor(
    private readonly endpoint: string,
    private readonly token: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async run(prompt: string, maxTokens: number): Promise<InferenceBackendResult> {
    if (!this.token || this.token.length < 32) {
      throw new CloudInferenceBlockedError('CLOUD_AUTH_OR_POLICY_BLOCKED', 'Cloud inference credential unavailable');
    }
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, max_tokens: maxTokens }),
    });
    const body = await response.text();
    if (!response.ok) throw classifyCloudflareFailure(response.status, body);
    let payload: any;
    try { payload = JSON.parse(body); } catch { throw new CloudInferenceBlockedError('CLOUD_INFERENCE_FAILED', 'Invalid cloud response'); }
    const neurons = payload?.result?.usage?.neurons;
    if (payload?.protocol !== 'VONE_CLOUD_INFERENCE_R1' || payload?.status !== 'DONE' ||
        typeof payload?.result?.response !== 'string' || typeof payload?.model !== 'string' ||
        typeof neurons !== 'number' || !Number.isFinite(neurons) || neurons < 0) {
      throw new CloudInferenceBlockedError('CLOUD_INFERENCE_FAILED', 'Invalid cloud inference contract');
    }
    return { text: payload.result.response, model: payload.model, neurons };
  }
}

export class OllamaInferenceBackend implements InferenceBackend {
  constructor(
    private readonly baseUrl = 'http://127.0.0.1:11434',
    private readonly model = 'v-one-coder:fast',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async run(prompt: string, maxTokens: number): Promise<InferenceBackendResult> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt, stream: false, options: { num_predict: maxTokens } }),
    });
    if (!response.ok) throw new Error(`Ollama inference failed: HTTP ${response.status}`);
    const payload = await response.json() as { response?: unknown; model?: unknown };
    if (typeof payload.response !== 'string') throw new Error('Ollama inference returned invalid contract');
    return { text: payload.response, model: typeof payload.model === 'string' ? payload.model : this.model };
  }
}
