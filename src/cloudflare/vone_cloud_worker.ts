interface WorkersAI {
  run(model: string, input: unknown): Promise<unknown>;
}
interface Env { AI: WorkersAI; }

const MODEL = '@cf/qwen/qwen2.5-coder-32b-instruct';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({
        service: 'V-ONE Cloud Inference R1',
        status: 'READY',
        inference_policy: 'VERIFIED_FREE_ONLY',
        paid_blocked: 'INVIOLABLE',
        physical_output: 'LOCKED',
        model: MODEL,
      });
    }
    if (request.method !== 'POST' || url.pathname !== '/infer') {
      return json({ error: 'not_found' }, 404);
    }

    let body: { prompt?: unknown; max_tokens?: unknown };
    try { body = await request.json() as typeof body; }
    catch { return json({ error: 'invalid_json' }, 400); }

    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt || prompt.length > 20000) return json({ error: 'invalid_prompt' }, 400);
    const maxTokens = Number.isInteger(body.max_tokens)
      ? Math.min(Math.max(Number(body.max_tokens), 1), 1024)
      : 512;

    try {
      const result = await env.AI.run(MODEL, {
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        // Fail fast so V-ONE Master can choose another verified-free worker.
        queueRequest: false,
      });
      return json({ protocol: 'VONE_CLOUD_INFERENCE_R1', status: 'DONE', model: MODEL, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Do not expose provider internals; Master treats unavailable cloud as HOLD/fallback-local.
      return json({
        protocol: 'VONE_CLOUD_INFERENCE_R1',
        status: 'HOLD',
        error_class: 'CLOUD_CAPACITY_OR_POLICY_BLOCKED',
        message: message.slice(0, 240),
      }, 503);
    }
  },
} satisfies ExportedHandler<Env>;
