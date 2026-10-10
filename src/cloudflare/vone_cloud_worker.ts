interface WorkersAI { run(model: string, input: unknown): Promise<unknown>; }
interface Env { AI: WorkersAI; VONE_INFERENCE_TOKEN?: string; }

const MODEL = '@cf/qwen/qwen2.5-coder-32b-instruct';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
function authorized(request: Request, env: Env): boolean {
  const expected = env.VONE_INFERENCE_TOKEN;
  if (!expected || expected.length < 32) return false;
  const auth = request.headers.get('authorization');
  return auth === `Bearer ${expected}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ service: 'V-ONE Cloud Inference R1', status: 'READY', auth: 'REQUIRED_FOR_INFERENCE', inference_policy: 'VERIFIED_FREE_ONLY', paid_blocked: 'INVIOLABLE', physical_output: 'LOCKED', model: MODEL });
    }
    if (request.method !== 'POST' || url.pathname !== '/infer') return json({ error: 'not_found' }, 404);
    if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401);

    let body: { prompt?: unknown; max_tokens?: unknown };
    try { body = await request.json() as typeof body; } catch { return json({ error: 'invalid_json' }, 400); }
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt || prompt.length > 20000) return json({ error: 'invalid_prompt' }, 400);
    const maxTokens = Number.isInteger(body.max_tokens) ? Math.min(Math.max(Number(body.max_tokens), 1), 1024) : 512;

    try {
      const result = await env.AI.run(MODEL, { messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, queueRequest: false });
      return json({ protocol: 'VONE_CLOUD_INFERENCE_R1', status: 'DONE', model: MODEL, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ protocol: 'VONE_CLOUD_INFERENCE_R1', status: 'HOLD', error_class: 'CLOUD_CAPACITY_OR_POLICY_BLOCKED', message: message.slice(0, 240) }, 503);
    }
  },
};

