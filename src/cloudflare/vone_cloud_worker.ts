import { assertVerifiedCapacitySnapshot } from '../server/vone_capacity_snapshot';

interface WorkersAI { run(model: string, input: unknown): Promise<unknown>; }
interface Env { AI: WorkersAI; VONE_INFERENCE_TOKEN?: string; }
const MODEL = '@cf/qwen/qwen2.5-coder-32b-instruct';
const AUTHORITY_URL = 'https://vone-control-plane.vone-technology.workers.dev/api/status';
const MAX_AUTHORITY_AGE_MS = 120_000;
const MAX_OWNED_HEARTBEAT_AGE_MS = 120_000;
type AuthorityStatus = { availableAfterReserve: number; cloudState: string; ownedHeartbeatFresh: boolean };
let reservedDay = new Date().toISOString().slice(0, 10);
let locallyReservedNeurons = 0;
function json(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }); }
function authorized(request: Request, env: Env): boolean { const expected = env.VONE_INFERENCE_TOKEN; return Boolean(expected && expected.length >= 32 && request.headers.get('authorization') === ['Bearer', expected].join(' ')); }
function object(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }
function getSnapshot(root: Record<string, unknown>): Record<string, unknown> | null { return object(root.capacity_snapshot) ?? object(root.capacity) ?? root; }
function getBudget(root: Record<string, unknown>, snapshot: Record<string, unknown>): number | null {
  const budget = object(root.neuron_budget) ?? object(root.budget) ?? object(snapshot.neuron_budget) ?? object(snapshot.budget);
  if (!budget || budget.protocol !== 'VONE_NEURON_BUDGET_R1' || number(budget.reserve) === null || number(budget.reserve) === 0 || (budget.state !== undefined && budget.state !== 'FREE_AVAILABLE')) return null;
  const available = number(budget.availableForDispatch ?? budget.available_for_dispatch);
  if (available !== null) return available;
  const reserve = number(budget.reserve), remaining = number(budget.remaining);
  if (reserve !== null && remaining !== null && remaining >= reserve) return remaining - reserve;
  const limit = number(budget.limit), used = number(budget.used);
  return reserve !== null && limit !== null && used !== null && limit >= used + reserve ? limit - used - reserve : null;
}
function isFreshOwnedHeartbeat(root: Record<string, unknown>, nowMs: number): boolean {
  const candidates: unknown[] = [], direct = object(root.owned_heartbeat) ?? object(root.ownedHeartbeat);
  if (direct) candidates.push(direct);
  if (Array.isArray(root.owned_workers)) candidates.push(...root.owned_workers);
  if (Array.isArray(root.workers)) candidates.push(...root.workers);
  return candidates.some(candidate => {
    const worker = object(candidate); if (!worker) return false;
    const payload = object(worker.statusPayload) ?? object(worker.status_payload) ?? worker;
    const timestamp = worker.last_heartbeat_at ?? worker.heartbeat_at ?? worker.last_seen ?? worker.updated_at ?? worker.updatedAt ?? payload.heartbeat_at;
    const heartbeatMs = Date.parse(String(timestamp ?? ''));
    return (payload.role ?? worker.role) === 'OWNED_EXECUTOR' && (payload.mode ?? worker.mode ?? worker.status) === 'ONLINE' && Array.isArray(payload.capabilities ?? worker.capabilities) && (payload.capabilities as unknown[] ?? worker.capabilities as unknown[]).includes('vone_executor_execute') && Number.isFinite(heartbeatMs) && heartbeatMs <= nowMs + 30_000 && nowMs - heartbeatMs <= MAX_OWNED_HEARTBEAT_AGE_MS;
  });
}
async function readAuthority(): Promise<AuthorityStatus> {
  const response = await fetch(AUTHORITY_URL, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`authority_http_${response.status}`);
  const root = object(await response.json()); if (!root) throw new Error('authority_payload_invalid');
  const snapshot = getSnapshot(root), selected = object(snapshot?.selected), route = object(selected?.route), state = selected?.state ?? route?.state ?? 'UNKNOWN';
  const generatedAt = Date.parse(String(snapshot?.generated_at ?? '')), nowMs = Date.now();
  if (!Number.isFinite(generatedAt) || generatedAt > nowMs + 30_000 || nowMs - generatedAt > MAX_AUTHORITY_AGE_MS) throw new Error('authority_snapshot_stale');
  try { assertVerifiedCapacitySnapshot(snapshot, { nowMs, maxSnapshotAgeMs: MAX_AUTHORITY_AGE_MS, expectedProviderContains: 'cloudflare', preferredModel: MODEL }); } catch { throw new Error('authority_capacity_snapshot_unverified'); }
  const cost = object(route?.cost), invariants = object(snapshot?.invariants), provider = String(route?.provider ?? '').toLowerCase();
  const budget = getBudget(root, snapshot ?? {}), cloudState = String(state), models = object(route?.capabilities)?.models;
  if (snapshot?.protocol !== 'VONE_CAPACITY_SNAPSHOT_R1' || snapshot.authority !== 'VONE_MASTER' || cloudState !== 'FREE_AVAILABLE' || selected?.state !== 'FREE_AVAILABLE' || route?.state !== 'FREE_AVAILABLE' || cost?.verified_zero_cost !== true || cost.variable_cost_allowed !== false || !['free', 'grant', 'included'].includes(String(cost.billing_mode ?? '')) || invariants?.paid_blocked !== 'INVIOLABLE' || invariants.unknown_cost !== 'HOLD' || invariants.physical_output !== 'LOCKED' || !provider.includes('cloudflare') || (Array.isArray(models) && models.length > 0 && !models.includes(MODEL)) || budget === null) throw new Error('authority_zero_cost_capacity_unverified');
  const today = new Date().toISOString().slice(0, 10); if (today !== reservedDay) { reservedDay = today; locallyReservedNeurons = 0; }
  return { availableAfterReserve: Math.max(0, budget - locallyReservedNeurons), cloudState, ownedHeartbeatFresh: isFreshOwnedHeartbeat(root, nowMs) };
}
function estimateNeurons(prompt: string, maxTokens: number): number { return Math.max(1, Math.ceil((Math.ceil(prompt.length / 3) + maxTokens) / 100) * 2); }
function holdResponse(reason: string, status = 503): Response { return json({ protocol: 'VONE_DELEGATE_EXECUTE_R1', status: 'HOLD', target: 'HOLD', reason, paid_fallback: false, appdeploy_required: false, paid_blocked: 'INVIOLABLE', unknown_cost: 'HOLD', physical_output: 'LOCKED' }, status); }
async function authorizedAuthority(): Promise<AuthorityStatus> { try { return await readAuthority(); } catch { throw new Error('authority_unavailable_or_unverified'); } }
async function runInference(env: Env, prompt: string, maxTokens: number, protocol: 'VONE_DELEGATE_EXECUTE_R1' | 'VONE_CLOUD_INFERENCE_R1'): Promise<Response> {
  let authority: AuthorityStatus; try { authority = await authorizedAuthority(); } catch { return holdResponse('AUTHORITY_UNAVAILABLE_OR_UNVERIFIED'); }
  const estimatedNeurons = estimateNeurons(prompt, maxTokens); if (authority.availableAfterReserve < estimatedNeurons) return holdResponse('NEURON_BUDGET_AFTER_RESERVE_INSUFFICIENT');
  locallyReservedNeurons += estimatedNeurons;
  try { const result = await env.AI.run(MODEL, { messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, queueRequest: false }); return json({ protocol, status: 'DONE', target: 'CLOUD_FREE', route: 'cloudflare-workers-ai', paid_fallback: false, appdeploy_required: false, model: MODEL, estimated_neurons: estimatedNeurons, result }); }
  catch { return protocol === 'VONE_DELEGATE_EXECUTE_R1' ? holdResponse('CLOUD_FREE_EXECUTION_FAILED') : json({ protocol, status: 'HOLD', target: 'HOLD', paid_fallback: false, appdeploy_required: false, error_class: 'CLOUD_CAPACITY_OR_POLICY_BLOCKED' }, 503); }
}
function requestedMode(body: Record<string, unknown>): string { const mode = body.mode ?? body.tier; return typeof mode === 'string' ? mode.trim().toUpperCase() : ''; }
async function delegate(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>; try { const value = object(await request.json()); if (!value) return json({ error: 'invalid_json' }, 400); body = value; } catch { return json({ error: 'invalid_json' }, 400); }
  const mode = requestedMode(body);
  if (mode === 'SMART' || mode === 'MAX') { try { const authority = await authorizedAuthority(); return holdResponse(authority.ownedHeartbeatFresh ? 'OWNED_EXECUTOR_DIRECT_DELEGATION_UNAVAILABLE' : 'VERIFIED_FRESH_OWNED_HEARTBEAT_REQUIRED'); } catch { return holdResponse('AUTHORITY_UNAVAILABLE_OR_UNVERIFIED'); } }
  if (mode !== 'FAST' && mode !== 'AUTO') return holdResponse('UNSUPPORTED_DELEGATE_MODE', 400);
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''; if (!prompt || prompt.length > 20_000) return json({ error: 'invalid_prompt' }, 400);
  const maxTokens = Number.isInteger(body.max_tokens) ? Math.min(Math.max(Number(body.max_tokens), 1), 1024) : 512;
  return runInference(env, prompt, maxTokens, 'VONE_DELEGATE_EXECUTE_R1');
}
async function recovery(): Promise<Response> {
  try { const authority = await authorizedAuthority(); return json({ protocol: 'VONE_RECOVERY_SNAPSHOT_R1', status: 'READY', authority: AUTHORITY_URL, cloud_state: authority.cloudState, neurons_available_after_reserve: authority.availableAfterReserve, owned_heartbeat_fresh: authority.ownedHeartbeatFresh, captured_at: new Date().toISOString(), paid_blocked: 'INVIOLABLE', unknown_cost: 'HOLD', physical_output: 'LOCKED' }); }
  catch { return json({ protocol: 'VONE_RECOVERY_SNAPSHOT_R1', status: 'HOLD', authority: AUTHORITY_URL, reason: 'AUTHORITY_UNAVAILABLE_OR_UNVERIFIED', captured_at: new Date().toISOString(), paid_blocked: 'INVIOLABLE', unknown_cost: 'HOLD', physical_output: 'LOCKED' }, 503); }
}
async function publicStatus(): Promise<Response> {
  try { const authority = await authorizedAuthority(); return json({ protocol: 'VONE_CLOUD_STATUS_R1', status: 'FREE_AVAILABLE', authority: AUTHORITY_URL, cloud_state: authority.cloudState, neurons_available_after_reserve: authority.availableAfterReserve, owned_heartbeat_fresh: authority.ownedHeartbeatFresh, paid_blocked: 'INVIOLABLE', unknown_cost: 'HOLD', physical_output: 'LOCKED' }); }
  catch { return json({ protocol: 'VONE_CLOUD_STATUS_R1', status: 'HOLD', authority: AUTHORITY_URL, cloud_state: 'UNKNOWN', reason: 'AUTHORITY_UNAVAILABLE_OR_UNVERIFIED', paid_blocked: 'INVIOLABLE', unknown_cost: 'HOLD', physical_output: 'LOCKED' }); }
}
async function logRecoverySnapshot(): Promise<void> {
  try { const authority = await authorizedAuthority(); console.log(JSON.stringify({ protocol: 'VONE_RECOVERY_SNAPSHOT_R1', status: 'READY', captured_at: new Date().toISOString(), cloud_state: authority.cloudState, neurons_available_after_reserve: authority.availableAfterReserve, owned_heartbeat_fresh: authority.ownedHeartbeatFresh })); }
  catch { console.log(JSON.stringify({ protocol: 'VONE_RECOVERY_SNAPSHOT_R1', status: 'HOLD', captured_at: new Date().toISOString(), reason: 'AUTHORITY_UNAVAILABLE_OR_UNVERIFIED' })); }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return json({ service: 'V-ONE Cloud Inference R1', status: 'READY', auth: 'REQUIRED_FOR_INFERENCE', inference_policy: 'VERIFIED_FREE_ONLY', paid_blocked: 'INVIOLABLE', unknown_cost: 'HOLD', physical_output: 'LOCKED', model: MODEL });
    if (request.method === 'GET' && url.pathname === '/status') return publicStatus();
    if (request.method === 'GET' && url.pathname === '/recovery') { if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401); return recovery(); }
    if (request.method === 'POST' && (url.pathname === '/delegate' || url.pathname === '/infer')) {
      if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401);
      if (url.pathname === '/delegate') return delegate(request, env);
      let body: Record<string, unknown> | null; try { body = object(await request.json()); } catch { return json({ error: 'invalid_json' }, 400); }
      if (!body) return json({ error: 'invalid_json' }, 400);
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''; if (!prompt || prompt.length > 20_000) return json({ error: 'invalid_prompt' }, 400);
      const maxTokens = Number.isInteger(body.max_tokens) ? Math.min(Math.max(Number(body.max_tokens), 1), 1024) : 512;
      return runInference(env, prompt, maxTokens, 'VONE_CLOUD_INFERENCE_R1');
    }
    return json({ error: 'not_found' }, 404);
  },
  scheduled(_controller: unknown, _env: Env, context: { waitUntil(promise: Promise<unknown>): void }): void { context.waitUntil(logRecoverySnapshot()); },
};