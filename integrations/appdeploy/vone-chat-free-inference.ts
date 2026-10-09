/**
 * Server-side V-ONE Chat adapter. This file is a staging artifact; it is not
 * imported by the deployed AppDeploy app until its release gate passes.
 * Secrets must be supplied by the hosting platform, never from the browser.
 */
export type InferenceResult =
  | { status: 'PASS'; answer: string; provider: string; model: string }
  | { status: 'HOLD'; reason: string };
export interface FreeGatewayConfig {
  endpoint?: string;
  token?: string;
  freePlanVerified: boolean;
  masterRouteApproved: boolean;
}
export async function inferViaVerifiedFreeGateway(
  message: string,
  config: FreeGatewayConfig,
  fetcher: typeof fetch = fetch
): Promise<InferenceResult> {
  if (!config.freePlanVerified) return { status: 'HOLD', reason: 'FREE_PLAN_UNVERIFIED' };
  if (!config.masterRouteApproved) return { status: 'HOLD', reason: 'MASTER_ROUTE_NOT_APPROVED' };
  if (!config.endpoint || !config.token) return { status: 'HOLD', reason: 'GATEWAY_NOT_CONFIGURED' };
  let url: URL;
  try { url = new URL(config.endpoint); }
  catch { return { status: 'HOLD', reason: 'INVALID_GATEWAY_URL' }; }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/infer')
    return { status: 'HOLD', reason: 'INVALID_GATEWAY_URL' };
  if (!message.trim() || message.length > 5000)
    return { status: 'HOLD', reason: 'INVALID_MESSAGE' };
  try {
    const response = await fetcher(url.toString(), {
      method: 'POST',
      headers: { authorization: 'Bearer ' + config.token, 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(25000)
    });
    if (!response.ok) return { status: 'HOLD', reason: response.status === 429 ? 'FREE_QUOTA_OR_CAPACITY' : 'GATEWAY_UNAVAILABLE' };
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object') return { status: 'HOLD', reason: 'INVALID_MODEL_RESPONSE' };
    const payload = data as Record<string, unknown>;
    if (payload.status !== 'PASS' || payload.provider !== 'cloudflare-workers-ai' || !payload.result || typeof payload.result !== 'object')
      return { status: 'HOLD', reason: 'UNVERIFIED_MODEL_RESPONSE' };
    const result = payload.result as Record<string, unknown>;
    const answer = typeof result.response === 'string' ? result.response.trim() : '';
    if (!answer) return { status: 'HOLD', reason: 'EMPTY_MODEL_RESPONSE' };
    return { status: 'PASS', answer, provider: 'cloudflare-workers-ai', model: String(payload.model || '') };
  } catch {
    return { status: 'HOLD', reason: 'GATEWAY_NETWORK_FAILURE' };
  }
}
