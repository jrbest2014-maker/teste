/**
 * V-ONE Zero-Cost Cloudflare Workers AI gateway (isolated candidate).
 * Deploy ONLY after account plan has been verified as Workers Free.
 * Never put the shared bearer token in a browser bundle.
 */
export interface Env {
  AI: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
  VONE_GATEWAY_TOKEN: string;
  VONE_ACCOUNT_PLAN: string;
  VONE_FREE_ONLY: string;
}
const MODEL = '@cf/zai-org/glm-4.7-flash';
const respond = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'GET' && new URL(request.url).pathname === '/health')
      return respond(200, { service: 'vone-free-ai-gateway', state: 'UNVERIFIED', inference: false });
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/infer')
      return respond(404, { error: 'NOT_FOUND' });
    if (env.VONE_FREE_ONLY !== 'true' || env.VONE_ACCOUNT_PLAN !== 'workers-free')
      return respond(503, { status: 'HOLD', reason: 'ACCOUNT_FREE_PLAN_NOT_VERIFIED' });
    if (!env.VONE_GATEWAY_TOKEN || request.headers.get('authorization') !== 'Bearer ' + env.VONE_GATEWAY_TOKEN)
      return respond(401, { error: 'UNAUTHORIZED' });
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
      return respond(415, { error: 'JSON_REQUIRED' });
    let input: { message?: unknown };
    try { input = await request.json() as { message?: unknown }; }
    catch { return respond(400, { error: 'INVALID_JSON' }); }
    if (typeof input.message !== 'string' || input.message.trim().length < 1 || input.message.length > 5000)
      return respond(400, { error: 'INVALID_MESSAGE' });
    try {
      const result = await env.AI.run(MODEL, { messages: [{ role: 'user', content: input.message }], max_tokens: 512 });
      return respond(200, { status: 'PASS', provider: 'cloudflare-workers-ai', model: MODEL, result });
    } catch {
      return respond(503, { status: 'HOLD', reason: 'INFERENCE_UNAVAILABLE_OR_QUOTA_EXHAUSTED' });
    }
  }
};
