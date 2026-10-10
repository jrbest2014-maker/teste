interface WorkersAI { run(model: string, input: unknown): Promise<unknown>; }
interface Env { AI: WorkersAI; VONE_INFERENCE_TOKEN?: string; }

const MODEL = '@cf/qwen/qwen2.5-coder-32b-instruct';
const AUTHORITY_URL = 'https://vone-control-plane.vone-technology.workers.dev/api/status';
const MAX_AUTHORITY_AGE_MS = 120_000;
const MAX_OWNED_HEARTBEAT_AGE_MS = 120_000;
const MASTER_PROTOCOL = 'VONE_DELEGATE_AUTHORITY_R2';
const RECOVERY_PROTOCOL = 'VONE_CLOUD_RECOVERY_SNAPSHOT_R2';
const AUTHORITY_SOURCE = 'VONE_MASTER_CLOUDFLARE';

type MasterStatus = {
  cloudAiExecution?: unknown; cloudBudget?: unknown; ownedHeartbeat?: unknown; owned_heartbeat?: unknown;
  ownedWorkers?: unknown; owned_workers?: unknown; workers?: unknown; timestamp?: unknown; updatedAt?: unknown;
  updated_at?: unknown; generatedAt?: unknown; generated_at?: unknown; observedAt?: unknown; observed_at?: unknown;
  lastUpdated?: unknown; last_updated?: unknown; [key: string]: unknown;
};
type AuthorityResult = {
  protocol: typeof MASTER_PROTOCOL; source: typeof AUTHORITY_SOURCE; cloud_verified_zero_cost: boolean;
  owned_fresh_heartbeat: boolean; paid_fallback: false; unknown_cost: 'HOLD'; physical_output: 'LOCKED';
  appdeploy_required: false; remaining_neurons: number | null; hard_cap_neurons: number | null;
  protected_reserve_neurons: number | null; estimated_neurons: number; reason: string;
};
let reservedDay = new Date().toISOString().slice(0, 10);
let locallyReservedNeurons = 0;
function json(body: unknown, status = 200): Response {
  const payload = object(body);
  const responseBody = payload ? { ...payload, paid_fallback: false, appdeploy_required: false, unknown_cost: 'HOLD', physical_output: 'LOCKED' } : body;
  return new Response(JSON.stringify(responseBody), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
function authorized(request: Request, env: Env): boolean {
  const expected = env.VONE_INFERENCE_TOKEN;
  return Boolean(expected && expected.length >= 32 && request.headers.get('authorization') === ['Bearer', expected].join(' '));
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function finiteNumber(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function estimateNeurons(prompt: string, maxTokens: number, callerEstimate?: unknown): number {
  const estimatedPromptTokens = Math.max(1, Math.ceil(prompt.length / 3));
  const internalNeuronEstimate = Math.ceil((estimatedPromptTokens * 0.06 + maxTokens * 0.090909) * 1.25);
  const requestedEstimate = finiteNumber(callerEstimate);
  return requestedEstimate !== null && requestedEstimate > 0 ? Math.max(internalNeuronEstimate, requestedEstimate) : internalNeuronEstimate;
}
function verifyOwnedHeartbeat(master: MasterStatus, nowMs: number): boolean {
  const candidates: unknown[] = [];
  const direct = object(master.ownedHeartbeat) ?? object(master.owned_heartbeat);
  if (direct) candidates.push(direct);
  if (Array.isArray(master.ownedWorkers)) candidates.push(...master.ownedWorkers);
  if (Array.isArray(master.owned_workers)) candidates.push(...master.owned_workers);
  if (Array.isArray(master.workers)) candidates.push(...master.workers);
  return candidates.some(candidate => {
    const worker = object(candidate); if (!worker) return false;
    const payload = object(worker.statusPayload) ?? object(worker.status_payload) ?? worker;
    const capabilities = payload.capabilities ?? worker.capabilities;
    const timestamp = worker.last_heartbeat_at ?? worker.heartbeat_at ?? worker.last_seen ?? worker.updated_at ?? worker.updatedAt ?? payload.heartbeat_at;
    const heartbeatMs = Date.parse(String(timestamp ?? ''));
    return (payload.role ?? worker.role) === 'OWNED_EXECUTOR' && (payload.mode ?? worker.mode ?? worker.status) === 'ONLINE'
      && Array.isArray(capabilities) && capabilities.includes('vone_executor_execute') && Number.isFinite(heartbeatMs)
      && heartbeatMs <= nowMs + 30_000 && nowMs - heartbeatMs <= MAX_OWNED_HEARTBEAT_AGE_MS;
  });
}
function explicitTimestampIsFresh(master: MasterStatus, nowMs: number): boolean {
  const timeFields = ['timestamp', 'updatedAt', 'updated_at', 'generatedAt', 'generated_at', 'observedAt', 'observed_at', 'lastUpdated', 'last_updated'];
  const sources = [master, object(master.cloudBudget)].filter((source): source is Record<string, unknown> => source !== null);
  return sources.every(source => timeFields.every(field => {
    const timestamp = source[field]; if (timestamp === undefined || timestamp === null || timestamp === '') return true;
    const timeMs = typeof timestamp === 'number' ? timestamp : Date.parse(String(timestamp));
    return Number.isFinite(timeMs) && timeMs <= nowMs + 30_000 && nowMs - timeMs <= MAX_AUTHORITY_AGE_MS;
  }));
}
function authorityResponse(reason: string, estimatedNeurons: number, values: Partial<Pick<AuthorityResult,
  'cloud_verified_zero_cost' | 'owned_fresh_heartbeat' | 'remaining_neurons' | 'hard_cap_neurons' | 'protected_reserve_neurons'>> = {}): AuthorityResult {
  return { protocol: MASTER_PROTOCOL, source: AUTHORITY_SOURCE, cloud_verified_zero_cost: values.cloud_verified_zero_cost ?? false,
    owned_fresh_heartbeat: values.owned_fresh_heartbeat ?? false, paid_fallback: false, unknown_cost: 'HOLD', physical_output: 'LOCKED',
    appdeploy_required: false, remaining_neurons: values.remaining_neurons ?? null, hard_cap_neurons: values.hard_cap_neurons ?? null,
    protected_reserve_neurons: values.protected_reserve_neurons ?? null, estimated_neurons: estimatedNeurons, reason };
}
function reserveBudget(authority: AuthorityResult): AuthorityResult {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== reservedDay) { reservedDay = today; locallyReservedNeurons = 0; }
  const available = (authority.remaining_neurons ?? 0) - (authority.protected_reserve_neurons ?? 0) - locallyReservedNeurons;
  if (available < authority.estimated_neurons) return { ...authority, reason: 'NEURON_BUDGET_AFTER_RESERVE_INSUFFICIENT' };
  locallyReservedNeurons += authority.estimated_neurons; return authority;
}
async function readAuthority(estimatedNeurons: number): Promise<AuthorityResult> {
  let response: Response;
  try { response = await fetch(AUTHORITY_URL, { method: 'GET', headers: { accept: 'application/json', 'cache-control': 'no-cache' }, redirect: 'error', signal: AbortSignal.timeout(5_000) }); }
  catch { return authorityResponse('MASTER_UNAVAILABLE', estimatedNeurons); }
  if (!response.ok) return authorityResponse('MASTER_UNAVAILABLE', estimatedNeurons);
  let master: MasterStatus | null;
  try { master = object(await response.json()) as MasterStatus | null; }
  catch { return authorityResponse('MASTER_RESPONSE_INVALID', estimatedNeurons); }
  if (!master) return authorityResponse('MASTER_RESPONSE_INVALID', estimatedNeurons);
  const nowMs = Date.now(), heartbeat = verifyOwnedHeartbeat(master, nowMs);
  if (!explicitTimestampIsFresh(master, nowMs)) return authorityResponse('MASTER_STATUS_STALE', estimatedNeurons, { owned_fresh_heartbeat: heartbeat });
  const budget = object(master.cloudBudget), remaining = finiteNumber(budget?.remaining_neurons), hardCap = finiteNumber(budget?.hard_cap_neurons);
  if (master.cloudAiExecution !== 'FREE_AVAILABLE') return authorityResponse('CLOUD_ZERO_COST_NOT_VERIFIED', estimatedNeurons, {
    owned_fresh_heartbeat: heartbeat, remaining_neurons: remaining, hard_cap_neurons: hardCap,
  });
  if (remaining === null || remaining < 0 || hardCap === null || hardCap <= 0 || remaining > hardCap) return authorityResponse('CLOUD_BUDGET_INVALID', estimatedNeurons, {
    owned_fresh_heartbeat: heartbeat, remaining_neurons: remaining, hard_cap_neurons: hardCap,
  });
  const reserve = Math.max(500, hardCap * 0.10), today = new Date().toISOString().slice(0, 10);
  if (today !== reservedDay) { reservedDay = today; locallyReservedNeurons = 0; }
  const values = { cloud_verified_zero_cost: true, owned_fresh_heartbeat: heartbeat, remaining_neurons: remaining, hard_cap_neurons: hardCap, protected_reserve_neurons: reserve };
  if (remaining - reserve - locallyReservedNeurons < estimatedNeurons) return authorityResponse('NEURON_BUDGET_AFTER_RESERVE_INSUFFICIENT', estimatedNeurons, values);
  return authorityResponse('VERIFIED_FREE_WITHIN_BUDGET', estimatedNeurons, values);
}
function holdResponse(authority: AuthorityResult, status = 503, protocol: 'VONE_DELEGATE_AUTHORITY_R2' | 'VONE_CLOUD_INFERENCE_R1' = 'VONE_DELEGATE_AUTHORITY_R2'): Response {
  return json({ ...(protocol === 'VONE_DELEGATE_AUTHORITY_R2' ? authority : {}), protocol, authority, status: 'HOLD', target: 'HOLD', reason: authority.reason }, status);
}
async function executeFree(env: Env, prompt: string, maxTokens: number, protocol: 'VONE_DELEGATE_EXECUTE_R1' | 'VONE_CLOUD_INFERENCE_R1', callerEstimate?: unknown): Promise<Response> {
  const estimatedNeurons = estimateNeurons(prompt, maxTokens, callerEstimate), authority = await readAuthority(estimatedNeurons);
  const holdProtocol = protocol === 'VONE_CLOUD_INFERENCE_R1' ? 'VONE_CLOUD_INFERENCE_R1' : 'VONE_DELEGATE_AUTHORITY_R2';
  if (!authority.cloud_verified_zero_cost || authority.reason !== 'VERIFIED_FREE_WITHIN_BUDGET') return holdResponse(authority, 503, holdProtocol);
  const reservation = reserveBudget(authority);
  if (reservation.reason !== 'VERIFIED_FREE_WITHIN_BUDGET') return holdResponse(reservation, 503, holdProtocol);
  try {
    const result = await env.AI.run(MODEL, { messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, queueRequest: false });
    return json({ ...authority, protocol, authority, status: 'DONE', target: 'CLOUD_FREE', route: 'cloudflare-workers-ai', paid_fallback: false, appdeploy_required: false, model: MODEL, result });
  } catch {
    return holdResponse(authorityResponse('CLOUD_FREE_EXECUTION_FAILED', estimatedNeurons, {
      cloud_verified_zero_cost: authority.cloud_verified_zero_cost, owned_fresh_heartbeat: authority.owned_fresh_heartbeat,
      remaining_neurons: authority.remaining_neurons, hard_cap_neurons: authority.hard_cap_neurons, protected_reserve_neurons: authority.protected_reserve_neurons,
    }), 503, holdProtocol);
  }
}
function maxTokensFrom(body: Record<string, unknown>): number { return Number.isInteger(body.max_tokens) ? Math.min(Math.max(Number(body.max_tokens), 1), 1024) : 512; }
function promptFrom(body: Record<string, unknown>): string | null { const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''; return prompt.length > 0 && prompt.length <= 20_000 ? prompt : null; }
function delegateMode(body: Record<string, unknown>): string { const mode = body.mode ?? body.tier; return typeof mode === 'string' ? mode.trim().toUpperCase() : ''; }
async function delegate(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown> | null;
  try { body = object(await request.json()); } catch { return holdResponse(authorityResponse('REQUEST_INVALID', 0), 400); }
  if (!body) return holdResponse(authorityResponse('REQUEST_INVALID', 0), 400);
  const mode = delegateMode(body), prompt = promptFrom(body);
  if (!prompt) return holdResponse(authorityResponse('PROMPT_INVALID', 0), 400);
  const maxTokens = maxTokensFrom(body), estimatedNeurons = estimateNeurons(prompt, maxTokens, body.estimated_neurons);
  if (mode === 'SMART' || mode === 'MAX') {
    const authority = await readAuthority(estimatedNeurons);
    if (!authority.cloud_verified_zero_cost) return holdResponse(authority);
    return holdResponse(authority.owned_fresh_heartbeat
      ? authorityResponse('OWNED_EXECUTOR_DELEGATION_UNAVAILABLE', estimatedNeurons, { ...authority, owned_fresh_heartbeat: true })
      : authorityResponse('VERIFIED_FRESH_OWNED_HEARTBEAT_REQUIRED', estimatedNeurons, authority), 503);
  }
  if (mode !== 'FAST' && mode !== 'AUTO') return holdResponse(authorityResponse('DELEGATE_MODE_INVALID', estimatedNeurons), 400);
  return executeFree(env, prompt, maxTokens, 'VONE_DELEGATE_EXECUTE_R1', body.estimated_neurons);
}
async function recoverySnapshot(): Promise<AuthorityResult> { return readAuthority(0); }
async function recovery(): Promise<Response> {
  const authority = await recoverySnapshot();
  return json({ ...authority, protocol: RECOVERY_PROTOCOL, authority, status: authority.reason === 'VERIFIED_FREE_WITHIN_BUDGET' ? 'READY' : 'HOLD' }, authority.reason === 'VERIFIED_FREE_WITHIN_BUDGET' ? 200 : 503);
}
async function publicStatus(): Promise<Response> {
  const authority = await recoverySnapshot();
  return json({ ...authority, protocol: 'VONE_CLOUD_CONTROL_STATUS_R2', authority, architecture: 'CLOUDFLARE_DIRECT_CRITICAL_PATH_R2', appdeploy_required_for_fast: false, status: authority.reason === 'VERIFIED_FREE_WITHIN_BUDGET' ? 'FREE_AVAILABLE' : 'HOLD' });
}
async function logRecoverySnapshot(): Promise<void> {
  const authority = await recoverySnapshot();
  console.log(JSON.stringify({ protocol: RECOVERY_PROTOCOL, authority_protocol: MASTER_PROTOCOL, source: authority.source, captured_at: new Date().toISOString(), cloud_verified_zero_cost: authority.cloud_verified_zero_cost, owned_fresh_heartbeat: authority.owned_fresh_heartbeat, paid_fallback: false, unknown_cost: 'HOLD', physical_output: 'LOCKED', appdeploy_required: false, remaining_neurons: authority.remaining_neurons, hard_cap_neurons: authority.hard_cap_neurons, protected_reserve_neurons: authority.protected_reserve_neurons, estimated_neurons: 0, reason: authority.reason }));
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
      let body: Record<string, unknown> | null;
      try { body = object(await request.json()); } catch { return holdResponse(authorityResponse('REQUEST_INVALID', 0), 400, 'VONE_CLOUD_INFERENCE_R1'); }
      const prompt = body ? promptFrom(body) : null;
      if (!body || !prompt) return holdResponse(authorityResponse('PROMPT_INVALID', 0), 400, 'VONE_CLOUD_INFERENCE_R1');
      return executeFree(env, prompt, maxTokensFrom(body), 'VONE_CLOUD_INFERENCE_R1', body.estimated_neurons);
    }
    return json({ error: 'not_found' }, 404);
  },
  scheduled(_controller: unknown, _env: Env, context: { waitUntil(promise: Promise<unknown>): void }): void { context.waitUntil(logRecoverySnapshot()); },
};
