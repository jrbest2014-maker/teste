import { mobileAdminPage } from './mobile-admin.mjs';
import { accessPage } from './access-page.mjs';
import { userApi, ownerSession, approvedUserSession, approvedUserIdentity, userHasPermission, accountsEnforced } from './accounts.mjs';
import {
  ZERO_COST_POLICY,
  routeToDb,
  dbRowToRoute,
  deriveCapacityState,
  rankCapacityRoutes,
  planParallelVerification,
  resolveVerificationEvidence,
  canonicalVerificationJson,
  evaluateVerificationHashes
} from './capacity-broker.mjs';
import {
  mobilePage,
  mobileManifest,
  mobileIcon,
  mobileServiceWorker,
  startMobileEnrollment,
  mobileEnrollmentStatus,
  mobileAuthorized,
  mobileWhoAmI,
  mobileDisconnect,
  mobilePendingEnrollments,
  approveMobileEnrollment
} from './mobile-pwa.mjs';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const ALLOWED_TOOLS = new Set(['yellow_status','yellow_route_preview','ask_yellow','vone_executor_execute','vone_hub_chat','vone_status','vone_resume_mission','vone_list_missions','vone_list_artifacts','vone_capacity_plan','vone_checkpoint','vone_register_artifact','vone_dispatch_worker','vone_release_worker','vone_learning_record','vone_learning_summary','vone_delegate_execute','vone_job_status']);
const CLIENT_TOKEN_SHA256 = '74172c4ba4bc827ce26af5789ea234e32c74bec7cd97685fbb58677bb44969b7';
const WORKER_TOKEN_SHA256 = 'f9b5f821c81e3d7c2058d04099b5f83968e101bbd0d1de42c732e72b7ea1219c';
const MCP_PUBLIC_ORIGIN = 'https://vone-control-plane.vone-technology.workers.dev';
const MCP_RESOURCE = MCP_PUBLIC_ORIGIN + '/mcp';
const MCP_SECURE_RESOURCE = MCP_PUBLIC_ORIGIN + '/mcp-secure';
const OAUTH_ISSUER = MCP_PUBLIC_ORIGIN;
const OAUTH_SCOPE = 'mcp:tools';
const MCP_NOAUTH_SCHEME = [{ type: 'noauth' }];
const MCP_OAUTH_SCHEME = [{ type: 'oauth2', scopes: ['mcp:tools'] }];
const MCP_PUBLIC_TOOLS = new Set(['vone_status','vone_capacity_plan']);

const VONE_EXECUTION_POLICY = Object.freeze({
  id:'VONE_EFFICIENCY_EFFECTIVENESS_R1',
  priority_order:['CORRECTNESS','COMPLETION','LATENCY','RESOURCE_EFFICIENCY'],
  supervisor_mode:'LIGHTWEIGHT',
  production_bias:'FORWARD_WITH_VALIDATION',
  benign_authorized_action:'EXECUTE_NOT_LECTURE',
  blocker_style:'EXACT_GATE_PLUS_MINIMUM_REMEDIATION',
  generic_moralizing:false,
  retry_policy:'BOUNDED_IDEMPOTENT_ONLY',
  no_evidence_no_pass:true
});

const CLOUD_MODELS = {
  FAST: '@cf/zai-org/glm-4.7-flash',
  SMART: '@cf/nvidia/nemotron-3-120b-a12b',
  MAX: '@cf/nvidia/nemotron-3-120b-a12b'
};

const CLOUD_NEURON_DAILY_HARD_CAP = 10000;
const CLOUD_NEURON_RATES = Object.freeze({
  '@cf/zai-org/glm-4.7-flash': { input: 5500, output: 36400 },
  '@cf/nvidia/nemotron-3-120b-a12b': { input: 45455, output: 136364 }
});

function utcDayKey(now = new Date()) { return now.toISOString().slice(0, 10); }
function nextUtcReset(now = new Date()) { const d = new Date(now); d.setUTCHours(24,0,0,0); return d.toISOString(); }
function conservativeTokens(text) { return Math.max(1, Math.ceil(String(text || '').length / 2)); }
function estimateNeurons(model, inputTokens, outputTokens) {
  const rate = CLOUD_NEURON_RATES[model] || CLOUD_NEURON_RATES['@cf/nvidia/nemotron-3-120b-a12b'];
  return (Number(inputTokens || 0) * rate.input + Number(outputTokens || 0) * rate.output) / 1000000;
}

function selectCloudProfile(profile = 'AUTO', prompt = '') {
  const requested = String(profile || 'AUTO').toUpperCase();
  if (requested === 'FAST' || requested === 'SMART' || requested === 'MAX') return requested;
  const text = String(prompt || '');
  if (text.length > 12000 || /arquitet|engenhar|depur|debug|refator|seguran|planej|complex|multi[- ]?step/i.test(text)) return 'MAX';
  if (text.length > 2500) return 'SMART';
  return 'FAST';
}

function normalizeAiText(result) {
  if (typeof result === 'string') {
    const raw = result.trim();
    if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
      try { return normalizeAiText(JSON.parse(raw)); } catch {}
    }
    return result;
  }
  if (typeof result?.response === 'string') return result.response;
  if (typeof result?.result?.response === 'string') return result.result.response;
  const choice = result?.choices?.[0]?.message?.content;
  if (typeof choice === 'string') return choice;
  if (Array.isArray(choice)) return choice.map(x => typeof x === 'string' ? x : (x?.text || x?.content || '')).join('');
  const completion = result?.choices?.[0]?.text;
  if (typeof completion === 'string') return completion;
  if (Array.isArray(result?.choices)) return '';
  return JSON.stringify(result);
}

function cleanAiText(value, prompt = '') {
  let text = String(value || '').replace(/\u0000/g, '').replace(/\0/g, '');
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '');
  const wantsLatex = /\b(latex|tex|equação|equacao|fórmula|formula)\b/i.test(String(prompt || ''));
  if (!wantsLatex) {
    text = text.replace(/\\textsup\\\\?/g, '').replace(/\\textsup/g, '');
    text = text.replace(/^.*LaTeX.*(?:refer[eê]ncias?|reference file).*$\n?/gim, '');
  }
  text = text.replace(/^[ \\]+$/gm, '').replace(/\n{4,}/g, '\n\n\n').trim();
  return text;
}

async function cloudBudgetSnapshot(env) {
  const day = utcDayKey();
  const row = await env.DB.prepare('SELECT reserved_neurons,spent_neurons,calls,last_model,updated_at FROM cloud_ai_daily_budget WHERE day_utc=?').bind(day).first();
  const reserved = Number(row?.reserved_neurons || 0), spent = Number(row?.spent_neurons || 0);
  return { day, hard_cap_neurons: CLOUD_NEURON_DAILY_HARD_CAP, reserved_neurons: reserved, spent_neurons: spent, remaining_neurons: Math.max(0, CLOUD_NEURON_DAILY_HARD_CAP - reserved - spent), calls: Number(row?.calls || 0), last_model: row?.last_model || null, reset_at: nextUtcReset() };
}

async function reserveCloudBudget(env, model, prompt, maxTokens) {
  const day = utcDayKey(), now = Date.now();
  const inputTokens = conservativeTokens(prompt) + 600;
  const reserve = Math.max(1, estimateNeurons(model, inputTokens, maxTokens));
  await env.DB.prepare('INSERT OR IGNORE INTO cloud_ai_daily_budget(day_utc,reserved_neurons,spent_neurons,calls,last_model,updated_at) VALUES(?,0,0,0,NULL,?)').bind(day,now).run();
  const update = await env.DB.prepare('UPDATE cloud_ai_daily_budget SET reserved_neurons=reserved_neurons+?,updated_at=? WHERE day_utc=? AND reserved_neurons+spent_neurons+?<=?').bind(reserve,now,day,reserve,CLOUD_NEURON_DAILY_HARD_CAP).run();
  if (!update.meta?.changes) throw new Error('CLOUD_ZERO_COST_BUDGET_HOLD');
  return { day, model, reserve_neurons: reserve, input_tokens_est: inputTokens, output_tokens_cap: maxTokens };
}

async function settleCloudBudget(env, reservation, success) {
  if (!reservation) return;
  const n = Number(reservation.reserve_neurons || 0), now = Date.now();
  if (success) {
    await env.DB.prepare('UPDATE cloud_ai_daily_budget SET reserved_neurons=MAX(0,reserved_neurons-?),spent_neurons=spent_neurons+?,calls=calls+1,last_model=?,updated_at=? WHERE day_utc=?').bind(n,n,reservation.model,now,reservation.day).run();
  } else {
    await env.DB.prepare('UPDATE cloud_ai_daily_budget SET reserved_neurons=MAX(0,reserved_neurons-?),updated_at=? WHERE day_utc=?').bind(n,now,reservation.day).run();
  }
}

async function ensureCloudAiRoute(env) {
  const budget = await cloudBudgetSnapshot(env);
  const existing = await getCapacityRoute(env, 'cloudflare-workers-ai-primary');
  if (existing) return { route: existing, budget };

  const route = await upsertCapacityRoute(env, {
    route_id: 'cloudflare-workers-ai-primary', kind: 'cloud', provider: 'cloudflare-workers-ai', state: 'PAID_BLOCKED',
    cost: { billing_mode: 'unknown', variable_cost_allowed: false, verified_zero_cost: false, verification_source: 'entitlement-watcher-required', verified_at: null },
    quota: { remaining_pct: null, reserve_threshold_pct: 15, reset_at: budget.reset_at, confidence: 'unknown' },
    capabilities: { task_classes: ['LLM_FAST','LLM_LARGE_REASONING'], models: Object.values(CLOUD_MODELS), modalities: ['text'], accelerators: ['cloudflare-ai'], max_context_tokens: 131072, max_input_mb: 1 },
    health: { observed_at: new Date().toISOString(), ttl_seconds: 180, latency_ms_p50: null, latency_ms_p95: null, success_rate_15m: null, queue_depth: 0 },
    security: { trust_zone: 'cloud_controlled', allowed_privacy_classes: ['PUBLIC','INTERNAL','PRIVATE'] },
    constraints: { regions: [], max_concurrency: 4, requires_user_session: false },
    telemetry: { runtime: 'cloudflare-workers-ai', role: 'standby-until-zero-cost-verified', desktop_role: 'DEV_ONLY', daily_budget: budget }
  });
  return { route, budget };
}

async function runCloudAi(env, args = {}) {
  if (!env.AI || typeof env.AI.run !== 'function') throw new Error('Cloudflare AI binding unavailable');
  await ensureCloudAiRoute(env);
  const cloudRoute = await getCapacityRoute(env, 'cloudflare-workers-ai-primary');
  const cloudEligible = cloudRoute &&
    ['FREE_AVAILABLE','FREE_QUEUE','FREE_QUOTA_LOW'].includes(cloudRoute.state) &&
    cloudRoute.cost?.variable_cost_allowed === false &&
    cloudRoute.cost?.verified_zero_cost === true;
  if (!cloudEligible) throw new Error('Cloudflare AI route is PAID_BLOCKED until zero-cost entitlement and quota are verified');
  const prompt = String(args.prompt || '').slice(0, 60000);
  if (!prompt) throw new Error('prompt required');
  const profile = selectCloudProfile(args.profile, prompt);
  const model = CLOUD_MODELS[profile];
  const maxTokens = Math.max(16, Math.min(Number(args.max_tokens || 512), 2048));
  const system = [
    'You are V-ONE YELLOW, cloud-first engineering intelligence.',
    'Answer in Portuguese unless the user asks for another language.',
    'Use clean Markdown suitable for a modern chat UI.',
    'Do not emit LaTeX commands unless the user explicitly requests mathematical or LaTeX notation.',
    'Never invent missing reference files, bibliography files, templates, or tool executions.',
    'When input comes from speech, interpret it as natural spoken language and silently resolve obvious speech-recognition mistakes only when context makes the intended wording clear.',
    'Voice delivery cues such as pace, pauses, and intensity are conversational signals only; never use them to infer health, identity, personality, or hidden emotional state.',
    'Do not expose chain-of-thought, hidden reasoning tags, or internal scratch work.',
    'For authorized benign engineering and operational tasks, prefer execution and concrete progress over generic refusal or moral commentary.',
    'Do not invent ethical or policy blockers. If a real blocker applies, name the exact gate, authorization boundary, cost constraint, security boundary, or unsupported capability and give the smallest concrete remediation.',
    'Optimize for correct completion first, then latency and resource efficiency. Avoid duplicated work, unnecessary context expansion, and repeated model calls.',
    'Move production forward through small validated increments: execute, verify evidence, checkpoint, then continue.',
    'Be precise, direct, and distinguish verified facts from hypotheses.'
  ].join(' ');

  const reservation = await reserveCloudBudget(env, model, system + '\n' + prompt, maxTokens);
  const startedAt = Date.now();
  let attempts = 0;
  try {
    let result;
    let chatFailed = false;
    try {
      attempts += 1;
      const input = {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt }
        ],
        max_tokens: maxTokens,
        temperature: 0.15,
        chat_template_kwargs: { enable_thinking: false, force_nonempty_content: true }
      };
      result = await env.AI.run(model, input);
    } catch {
      chatFailed = true;
      attempts += 1;
      result = await env.AI.run(model, {
        prompt: system + '\n\nUSER:\n' + prompt + '\n\nASSISTANT:\n',
        max_tokens: maxTokens,
        temperature: 0.15
      });
    }

    let text = cleanAiText(normalizeAiText(result), prompt);
    if (!text && !chatFailed) {
      attempts += 1;
      result = await env.AI.run(model, {
        prompt: system + '\n\nUSER:\n' + prompt + '\n\nASSISTANT:\n',
        max_tokens: maxTokens,
        temperature: 0.15
      });
      text = cleanAiText(normalizeAiText(result), prompt);
    }
    if (!text) throw new Error('Cloud model returned empty text');

    await settleCloudBudget(env, reservation, true);
    const budget = await cloudBudgetSnapshot(env);
    await ensureCloudAiRoute(env);
    return {
      text,
      model,
      profile,
      backend: 'cloudflare-workers-ai',
      cloud: true,
      desktop_runtime: false,
      attempts,
      elapsed_ms: Date.now() - startedAt,
      execution_policy: VONE_EXECUTION_POLICY.id,
      budget
    };
  } catch (error) {
    await settleCloudBudget(env, reservation, false).catch(() => {});
    throw error;
  }
}

async function runYellowWithFallback(env, args = {}) {
  try {
    const result = await runCloudAi(env, args);
    return { ...result, route: 'CLOUDFLARE_WORKERS_AI' };
  } catch (cloudError) {
    const localYellow = await workerSnapshotByCapability(env, 'ask_yellow');
    if (localYellow.online) {
      const result = await queueTool(env, 'ask_yellow', args, { preserveOnTimeout: true, timeoutMs: 26000 });
      return result && typeof result === 'object'
        ? { ...result, route: 'OWNED_YELLOW_FALLBACK', cloud_gate: 'PAID_BLOCKED_OR_UNVERIFIED' }
        : { text: String(result || ''), route: 'OWNED_YELLOW_FALLBACK', cloud_gate: 'PAID_BLOCKED_OR_UNVERIFIED' };
    }
    throw new Error('CLOUD_AND_LOCAL_YELLOW_HOLD: ' + String(cloudError?.message || cloudError).slice(0, 300));
  }
}

function reply(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

function authBearer(request) {
  const value = request.headers.get('authorization') || '';
  return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : '';
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

async function legacyClientAuthorized(request, pathToken = '') {
  const token = pathToken || authBearer(request);
  return token.length >= 32 && await sha256Hex(token) === CLIENT_TOKEN_SHA256;
}

async function ensureDirectOAuthSchema(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS oauth_clients (client_id TEXT PRIMARY KEY, redirect_uris_json TEXT NOT NULL, created_at INTEGER NOT NULL)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS oauth_codes (code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL, scope TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS oauth_tokens (token_hash TEXT PRIMARY KEY, refresh_hash TEXT NOT NULL, client_id TEXT NOT NULL, scope TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, refresh_expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)`).run();
  await env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_tokens_refresh ON oauth_tokens(refresh_hash)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS oauth_auth_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, ip_hash TEXT NOT NULL, ok INTEGER NOT NULL, created_at INTEGER NOT NULL)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_oauth_auth_attempts_ip_time ON oauth_auth_attempts(ip_hash, created_at)`).run();
}

async function oauthBearerAuthorized(request, env) {
  const bearer = authBearer(request);
  if (bearer.length < 32) return false;
  await ensureDirectOAuthSchema(env);
  const digest = await sha256Hex(bearer);
  const row = await env.DB.prepare('SELECT expires_at,revoked FROM oauth_tokens WHERE token_hash=?').bind(digest).first();
  return !!row && Number(row.revoked || 0) === 0 && Number(row.expires_at || 0) > Date.now();
}

async function ensureOperationalLearningSchema(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS operational_learning (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, decision TEXT, outcome TEXT, correction TEXT, checkpoint_ref TEXT, artifact_hashes_json TEXT NOT NULL DEFAULT '[]', tags_json TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL, created_at INTEGER NOT NULL)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_operational_learning_mission_time ON operational_learning(mission_id, created_at DESC)`).run();
}

async function recordOperationalLearning(env, input = {}) {
  await ensureOperationalLearningSchema(env);
  const id='learn_'+crypto.randomUUID(), now=Date.now(), missionId=String(input.mission_id||'vone-master').slice(0,128);
  const row={
    id,mission_id:missionId,kind:String(input.kind||'note').slice(0,80),summary:String(input.summary||'').slice(0,4000),
    decision:input.decision?String(input.decision).slice(0,4000):null,outcome:input.outcome?String(input.outcome).slice(0,4000):null,
    correction:input.correction?String(input.correction).slice(0,4000):null,checkpoint_ref:input.checkpoint_ref?String(input.checkpoint_ref).slice(0,240):null,
    artifact_hashes_json:JSON.stringify(Array.isArray(input.artifact_hashes)?input.artifact_hashes.map(String).slice(0,40):[]),
    tags_json:JSON.stringify(Array.isArray(input.tags)?input.tags.map(String).slice(0,40):[]),source:String(input.source||'mcp').slice(0,80),created_at:now
  };
  if(!row.summary) throw new Error('summary required');
  await env.DB.prepare('INSERT INTO operational_learning(id,mission_id,kind,summary,decision,outcome,correction,checkpoint_ref,artifact_hashes_json,tags_json,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(row.id,row.mission_id,row.kind,row.summary,row.decision,row.outcome,row.correction,row.checkpoint_ref,row.artifact_hashes_json,row.tags_json,row.source,row.created_at).run();
  return {...row,artifact_hashes:JSON.parse(row.artifact_hashes_json),tags:JSON.parse(row.tags_json)};
}

function randomToken(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  let s = '';
  for (const b of a) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

function trustedConnectorRedirectUri(value) {
  try {
    const u = new URL(String(value || ''));
    if (u.username || u.password) return false;
    const h = u.hostname.toLowerCase();
    const hosted = u.protocol === 'https:' && (
      h === 'claude.ai' || h.endsWith('.claude.ai') ||
      h === 'anthropic.com' || h.endsWith('.anthropic.com') ||
      h === 'chatgpt.com' || h.endsWith('.chatgpt.com') ||
      h === 'openai.com' || h.endsWith('.openai.com')
    );
    const loopback = u.protocol === 'http:' && (h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1');
    return hosted || loopback;
  } catch { return false; }
}

async function readForm(request) {
  const text = await request.text();
  return Object.fromEntries(new URLSearchParams(text));
}

function htmlPage(body, status = 200) {
  return new Response(body, { status, headers: { 'content-type':'text/html; charset=utf-8', 'cache-control':'no-store', 'x-frame-options':'DENY', 'referrer-policy':'no-referrer' } });
}

async function oauthAttemptAllowed(request, env) {
  await ensureDirectOAuthSchema(env);
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const ipHash = await sha256Hex(ip);
  const cutoff = Date.now() - 10 * 60 * 1000;
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM oauth_auth_attempts WHERE ip_hash=? AND ok=0 AND created_at>?').bind(ipHash, cutoff).first();
  return { allowed: Number(row?.n || 0) < 5, ipHash };
}

async function recordOAuthAttempt(env, ipHash, ok) {
  await env.DB.prepare('INSERT INTO oauth_auth_attempts(ip_hash,ok,created_at) VALUES(?,?,?)').bind(ipHash, ok ? 1 : 0, Date.now()).run();
}

function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));
}

async function oauthClient(env, clientId) {
  await ensureDirectOAuthSchema(env);
  return env.DB.prepare('SELECT client_id,redirect_uris_json FROM oauth_clients WHERE client_id=?').bind(clientId).first();
}

async function handleOAuthRegister(request, env) {
  await ensureDirectOAuthSchema(env);
  const body = await readJson(request);
  const redirects = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String).slice(0,10) : [];
  if (!redirects.length || redirects.some(u => !trustedConnectorRedirectUri(u))) return reply({error:'invalid_redirect_uri'},400);
  const clientId = 'vone_' + randomToken(18);
  await env.DB.prepare('INSERT INTO oauth_clients(client_id,redirect_uris_json,created_at) VALUES(?,?,?)').bind(clientId,JSON.stringify(redirects),Date.now()).run();
  return reply({client_id:clientId,client_id_issued_at:Math.floor(Date.now()/1000),redirect_uris:redirects,token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']},201);
}

async function validateOAuthRequest(env, p) {
  const clientId=String(p.client_id||''), redirectUri=String(p.redirect_uri||''), challenge=String(p.code_challenge||'');
  if(String(p.response_type||'')!=='code' || String(p.code_challenge_method||'')!=='S256' || !challenge) return {ok:false,error:'invalid_request'};
  const client=await oauthClient(env,clientId); if(!client) return {ok:false,error:'invalid_client'};
  let redirects=[]; try{redirects=JSON.parse(client.redirect_uris_json||'[]')}catch{}
  if(!redirects.includes(redirectUri) || !trustedConnectorRedirectUri(redirectUri)) return {ok:false,error:'invalid_redirect_uri'};
  return {ok:true,clientId,redirectUri,challenge,state:String(p.state||''),scope:OAUTH_SCOPE};
}

async function handleOAuthAuthorizeGet(request, env) {
  const p=Object.fromEntries(new URL(request.url).searchParams);
  const v=await validateOAuthRequest(env,p); if(!v.ok) return reply({error:v.error},400);
  const hidden=Object.entries({client_id:v.clientId,redirect_uri:v.redirectUri,response_type:'code',code_challenge:v.challenge,code_challenge_method:'S256',state:v.state,scope:OAUTH_SCOPE}).map(([k,val])=>`<input type="hidden" name="${k}" value="${htmlEscape(val)}">`).join('');
  return htmlPage(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>V-ONE Authorization</title><style>body{font-family:system-ui;background:#08101f;color:#eaf2ff;display:grid;place-items:center;min-height:100vh;margin:0}.card{width:min(92vw,430px);background:#101a2d;border:1px solid #2b3d5c;border-radius:18px;padding:24px}input,button{width:100%;box-sizing:border-box;padding:14px;border-radius:12px;margin-top:12px;font:inherit}input{background:#08101f;color:#fff;border:1px solid #405476}button{background:#dffb57;color:#111;border:0;font-weight:700}small{color:#9aacc6}</style><form class="card" method="post" action="/oauth/authorize"><h2>Autorizar V-ONE Master</h2><p>Libera ferramentas protegidas do V-ONE para este conector.</p>${hidden}<label>Código de aprovação V-ONE<input name="approval_code" type="password" autocomplete="one-time-code" required></label><button type="submit">Autorizar conexão</button><p><small>PKCE S256 · token rotativo · paid routes continuam bloqueadas.</small></p></form>`);
}

async function handleOAuthAuthorizePost(request, env) {
  const p=await readForm(request); const v=await validateOAuthRequest(env,p); if(!v.ok) return reply({error:v.error},400);
  const gate=await oauthAttemptAllowed(request,env); if(!gate.allowed) return htmlPage('<h2>Muitas tentativas. Aguarde 10 minutos.</h2>',429);
  const supplied=String(p.approval_code||''), expected=String(env.VONE_OAUTH_PAIR_CODE||'');
  const ok=expected.length>=6 && supplied.length>=6 && (await sha256Hex(supplied))===(await sha256Hex(expected));
  await recordOAuthAttempt(env,gate.ipHash,ok); if(!ok) return htmlPage('<h2>Código inválido.</h2><p>Volte e tente novamente.</p>',401);
  const code=randomToken(32), now=Date.now();
  await env.DB.prepare('INSERT INTO oauth_codes(code_hash,client_id,redirect_uri,code_challenge,scope,created_at,expires_at,used) VALUES(?,?,?,?,?,?,?,0)').bind(await sha256Hex(code),v.clientId,v.redirectUri,v.challenge,OAUTH_SCOPE,now,now+300000).run();
  const u=new URL(v.redirectUri); u.searchParams.set('code',code); if(v.state)u.searchParams.set('state',v.state);
  return new Response(null,{status:302,headers:{location:u.toString(),'cache-control':'no-store'}});
}

async function handleOAuthToken(request, env) {
  await ensureDirectOAuthSchema(env); const p=await readForm(request), grant=String(p.grant_type||''); const now=Date.now();
  if(grant==='authorization_code'){
    const digest=await sha256Hex(String(p.code||''));
    const row=await env.DB.prepare('SELECT * FROM oauth_codes WHERE code_hash=? AND used=0').bind(digest).first();
    if(!row || Number(row.expires_at||0)<now || row.client_id!==String(p.client_id||'') || row.redirect_uri!==String(p.redirect_uri||'')) return reply({error:'invalid_grant'},400);
    const expected=await sha256Hex(String(p.code_verifier||'')); const actual=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(p.code_verifier||'')))))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    if(actual!==row.code_challenge) return reply({error:'invalid_grant'},400);
    const access=randomToken(48), refresh=randomToken(48);
    await env.DB.prepare('UPDATE oauth_codes SET used=1 WHERE code_hash=?').bind(digest).run();
    await env.DB.prepare('INSERT INTO oauth_tokens(token_hash,refresh_hash,client_id,scope,created_at,expires_at,refresh_expires_at,revoked) VALUES(?,?,?,?,?,?,?,0)').bind(await sha256Hex(access),await sha256Hex(refresh),row.client_id,OAUTH_SCOPE,now,now+3600000,now+2592000000).run();
    return reply({access_token:access,token_type:'Bearer',expires_in:3600,refresh_token:refresh,scope:OAUTH_SCOPE,resource:MCP_RESOURCE});
  }
  if(grant==='refresh_token'){
    const rd=await sha256Hex(String(p.refresh_token||''));
    const row=await env.DB.prepare('SELECT * FROM oauth_tokens WHERE refresh_hash=? AND revoked=0').bind(rd).first();
    if(!row || Number(row.refresh_expires_at||0)<now || row.client_id!==String(p.client_id||'')) return reply({error:'invalid_grant'},400);
    const access=randomToken(48), refresh=randomToken(48);
    await env.DB.prepare('UPDATE oauth_tokens SET revoked=1 WHERE token_hash=?').bind(row.token_hash).run();
    await env.DB.prepare('INSERT INTO oauth_tokens(token_hash,refresh_hash,client_id,scope,created_at,expires_at,refresh_expires_at,revoked) VALUES(?,?,?,?,?,?,?,0)').bind(await sha256Hex(access),await sha256Hex(refresh),row.client_id,OAUTH_SCOPE,now,now+3600000,now+2592000000).run();
    return reply({access_token:access,token_type:'Bearer',expires_in:3600,refresh_token:refresh,scope:OAUTH_SCOPE,resource:MCP_RESOURCE});
  }
  return reply({error:'unsupported_grant_type'},400);
}

async function clientAuthorized(request, pathToken = '', env = null) {
  if (pathToken && await legacyClientAuthorized(request, pathToken)) return true;
  if (await legacyClientAuthorized(request)) return true;
  return env ? oauthBearerAuthorized(request, env) : false;
}

function mcpChallenge(metadataPath = '/.well-known/oauth-protected-resource/mcp') {
  const metadata = MCP_PUBLIC_ORIGIN + metadataPath;
  return reply({
    error: 'invalid_token',
    error_description: 'OAuth authentication required',
    resource_metadata: metadata
  }, 401, {
    'www-authenticate': `Bearer resource_metadata="${metadata}", scope="mcp:tools"`
  });
}

async function workerAuthorized(request) {
  const token = authBearer(request) || request.headers.get('x-vone-worker-token') || '';
  return token.length >= 32 && await sha256Hex(token) === WORKER_TOKEN_SHA256;
}

function constantTimeStringEqual(a, b) {
  const left = String(a || ''), right = String(b || '');
  if (!left.length || left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

async function authorizeWorkerRequest(request, env, body = {}) {
  const workerId = String(body.workerId || '').trim().slice(0, 120);
  const token = authBearer(request) || request.headers.get('x-vone-worker-token') || '';
  let identityReason = workerId ? 'NOT_FOUND' : 'MISSING_WORKER_ID';

  if (workerId && token.length >= 32) {
    try {
      const row = await env.DB.prepare(
        'SELECT worker_id,protocol,token_hash,status,generation,capabilities_json,last_authenticated_at FROM worker_identities_r1 WHERE worker_id=? LIMIT 1'
      ).bind(workerId).first();
      if (row) {
        if (row.protocol !== 'VONE_WORKER_IDENTITY_R1') identityReason = 'BAD_PROTOCOL';
        else if (row.status !== 'ACTIVE') identityReason = 'REVOKED';
        else {
          const digest = await sha256Hex(token);
          if (constantTimeStringEqual(digest, row.token_hash)) {
            const now = Date.now();
            await env.DB.prepare(
              'UPDATE worker_identities_r1 SET last_authenticated_at=? WHERE worker_id=? AND generation=?'
            ).bind(now, workerId, Number(row.generation || 0)).run();
            let capabilities = [];
            try {
              const parsed = JSON.parse(row.capabilities_json || '[]');
              if (Array.isArray(parsed)) capabilities = [...new Set(parsed.map(String).filter(Boolean))].slice(0, 64);
            } catch {}
            return {
              ok: true,
              mode: 'IDENTITY_R1',
              workerId,
              generation: Number(row.generation || 0),
              capabilities
            };
          }
          identityReason = 'TOKEN_MISMATCH';
          if (Number(row.last_authenticated_at || 0) > 0) {
            return { ok: false, mode: 'DENY', workerId, identity_reason: identityReason };
          }
        }
      }
    } catch {
      identityReason = 'IDENTITY_STORE_UNAVAILABLE';
    }
  } else if (workerId) {
    identityReason = 'MISSING_TOKEN';
  }

  if (await workerAuthorized(request)) {
    return {
      ok: true,
      mode: 'LEGACY_COMPAT',
      workerId,
      generation: null,
      capabilities: [],
      identity_reason: identityReason
    };
  }

  return { ok: false, mode: 'DENY', workerId, identity_reason: identityReason };
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function toolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

async function capacityAuthorized(request) {
  return (await clientAuthorized(request)) || (await workerAuthorized(request));
}

async function upsertCapacityRoute(env, input) {
  const now = Date.now();
  const { route, row } = routeToDb(input, now);
  await env.DB.prepare(`
    INSERT INTO capacity_routes (
      route_id,kind,provider,state,cost_json,quota_json,capabilities_json,
      health_json,security_json,constraints_json,telemetry_json,updated_at,heartbeat_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(route_id) DO UPDATE SET
      kind=excluded.kind,
      provider=excluded.provider,
      state=excluded.state,
      cost_json=excluded.cost_json,
      quota_json=excluded.quota_json,
      capabilities_json=excluded.capabilities_json,
      health_json=excluded.health_json,
      security_json=excluded.security_json,
      constraints_json=excluded.constraints_json,
      telemetry_json=excluded.telemetry_json,
      updated_at=excluded.updated_at,
      heartbeat_at=excluded.heartbeat_at
  `).bind(...row).run();
  return route;
}

async function getCapacityRoute(env, routeId) {
  const row = await env.DB.prepare('SELECT * FROM capacity_routes WHERE route_id=?').bind(routeId).first();
  return row ? dbRowToRoute(row) : null;
}

async function reconcileCapacityRoutes(env) {
  const out = await env.DB.prepare('SELECT * FROM capacity_routes ORDER BY route_id ASC').all();
  const rows = Array.isArray(out?.results) ? out.results : [];
  const now = Date.now();
  const routes = [];
  const transitions = [];
  for (const row of rows) {
    const route = dbRowToRoute(row, now);
    // The Ollama capacity route is only executable through the native owned
    // executor. A fresh capacity-route heartbeat alone must never advertise
    // LLM capacity after that worker disappears.
    if (route.route_id === 'local-ollama-vone-fallback') {
      const ownedExecutor = await workerSnapshotByCapability(env, 'vone_executor_execute');
      const ollamaHealthy =
        ownedExecutor.online &&
        ownedExecutor.worker?.status?.ollama_health === 'ONLINE';
      if (!ollamaHealthy) {
        route.state = 'OFFLINE';
        // rankCapacityRoutes derives state again from health; force the
        // in-memory observation stale so it cannot resurrect this route.
        route.health.observed_at = '1970-01-01T00:00:00.000Z';
      } else {
        // The executable route is the intersection of a fresh owned-worker
        // heartbeat and a successful Ollama health probe from that worker.
        // Use the worker heartbeat timestamp as the capacity observation so
        // a formerly stale route becomes available again without a separate
        // local capacity-heartbeat process.
        const workerObservedAt = Number(ownedExecutor.worker?.updatedAt || now);
        route.health.observed_at = new Date(workerObservedAt).toISOString();
        const capabilities=ownedExecutor.worker?.status?.capabilities||[];
        const contracts=ownedExecutor.worker?.status?.execution_contracts||[];
        if(capabilities.includes('CODE_REVIEW')&&contracts.includes('VONE_EXECUTION_CONTRACT_R1')){
          route.capabilities.task_classes=[...new Set([...(route.capabilities.task_classes||[]),'CODE_REVIEW'])];
        }
        route.state = deriveCapacityState(route, now);
      }
    }
    if (route.state !== row.state) {
      await env.DB.prepare('UPDATE capacity_routes SET state=?,updated_at=? WHERE route_id=?')
        .bind(route.state, now, route.route_id).run();
      const transition = { route_id: route.route_id, from: row.state, to: route.state, at: now };
      transitions.push(transition);
      await writeCapacityAudit(env, {
        routeId: route.route_id,
        decision: 'STATE_TRANSITION',
        reason: row.state + '->' + route.state,
        snapshot: {
          from: row.state,
          to: route.state,
          quota: route.quota,
          health: route.health
        }
      });
    }
    routes.push(route);
  }
  return { routes, transitions };
}

async function listCapacityRoutes(env) {
  return (await reconcileCapacityRoutes(env)).routes;
}

async function writeCapacityAudit(env, { taskId = null, routeId = null, decision, reason = null, snapshot = null }) {
  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO capacity_audit (id,task_id,route_id,decision,reason,policy_json,snapshot_json,created_at)
    VALUES (?,?,?,?,?,?,?,?)
  `).bind(
    id,
    taskId,
    routeId,
    String(decision || 'UNKNOWN'),
    reason ? String(reason).slice(0, 1000) : null,
    JSON.stringify(ZERO_COST_POLICY),
    snapshot ? JSON.stringify(snapshot) : null,
    Date.now()
  ).run();
  return id;
}

async function handleCapacityRegister(request, env) {
  if (!(await capacityAuthorized(request))) return reply({ error: 'Unauthorized' }, 401);
  const body = await readJson(request);
  try {
    const route = await upsertCapacityRoute(env, body);
    await writeCapacityAudit(env, {
      routeId: route.route_id,
      decision: 'REGISTER',
      reason: route.state,
      snapshot: { state: route.state, provider: route.provider, kind: route.kind }
    });
    return reply({ ok: true, route });
  } catch (e) {
    return reply({ error: e?.message || 'Invalid route' }, 400);
  }
}

async function handleCapacityHeartbeat(request, env) {
  if (!(await capacityAuthorized(request))) return reply({ error: 'Unauthorized' }, 401);
  const body = await readJson(request);
  const routeId = String(body.route_id || '');
  if (!routeId) return reply({ error: 'route_id required' }, 400);
  const current = await getCapacityRoute(env, routeId);
  if (!current) return reply({ error: 'Route not registered' }, 404);

  const merged = {
    ...current,
    state: body.state || current.state,
    cost: { ...current.cost, ...(body.cost || {}) },
    quota: { ...current.quota, ...(body.quota || {}) },
    capabilities: { ...current.capabilities, ...(body.capabilities || {}) },
    health: {
      ...current.health,
      ...(body.health || {}),
      observed_at: new Date().toISOString()
    },
    security: { ...current.security, ...(body.security || {}) },
    constraints: { ...current.constraints, ...(body.constraints || {}) },
    telemetry: { ...current.telemetry, ...(body.telemetry || {}) }
  };

  try {
    const route = await upsertCapacityRoute(env, merged);
    if (route.state !== current.state) {
      await writeCapacityAudit(env, {
        routeId: route.route_id,
        decision: 'STATE_TRANSITION',
        reason: current.state + '->' + route.state,
        snapshot: { from: current.state, to: route.state, quota: route.quota, health: route.health }
      });
    }
    return reply({ ok: true, route_id: route.route_id, state: route.state, observed_at: route.health.observed_at });
  } catch (e) {
    return reply({ error: e?.message || 'Heartbeat rejected' }, 400);
  }
}

async function handleCapacityRoutes(request, env) {
  if (!(await capacityAuthorized(request))) return reply({ error: 'Unauthorized' }, 401);
  const routes = await listCapacityRoutes(env);
  return reply({
    ok: true,
    policy: ZERO_COST_POLICY.id,
    count: routes.length,
    routes
  });
}

async function handleCapacityPlan(request, env) {
  if (!(await clientAuthorized(request))) return reply({ error: 'Unauthorized' }, 401);
  const body = await readJson(request);
  const task = {
    task_class: String(body.task_class || ''),
    privacy_class: String(body.privacy_class || 'PUBLIC'),
    prefer_local: body.prefer_local === true,
    locality: body.locality === 'client' ? 'client' : 'any',
    user_session: body.user_session === true
  };
  if (!task.task_class) return reply({ error: 'task_class required' }, 400);

  const routes = await listCapacityRoutes(env);
  const ranked = rankCapacityRoutes(routes, task, ZERO_COST_POLICY);
  const plan = {
    policy_id: ranked.policy_id,
    task: ranked.task,
    outcome: ranked.outcome,
    selected: ranked.selected ? {
      route_id: ranked.selected.route_id,
      state: ranked.selected.state,
      score: ranked.selected.score,
      breakdown: ranked.selected.breakdown
    } : null,
    ranked: ranked.ranked.map(x => ({
      route_id: x.route_id,
      state: x.state,
      score: x.score,
      breakdown: x.breakdown
    })),
    blocked: ranked.blocked.map(x => ({
      route_id: x.route_id,
      state: x.state,
      reasons: x.reasons
    }))
  };

  for (const item of [...plan.ranked, ...plan.blocked]) {
    await writeCapacityAudit(env, {
      taskId: body.task_id ? String(body.task_id).slice(0, 128) : null,
      routeId: item.route_id || null,
      decision: item.score === undefined ? 'BLOCKED' : 'RANKED',
      reason: item.reasons?.join(',') || item.state,
      snapshot: item
    });
  }

  return reply({ ok: true, dispatch: false, plan });
}

async function handleCapacityVerifyPlan(request, env) {
  if (!(await clientAuthorized(request))) return reply({ error: 'Unauthorized' }, 401);
  const body = await readJson(request);
  const task = {
    task_class: String(body.task_class || ''),
    privacy_class: String(body.privacy_class || 'PUBLIC'),
    prefer_local: body.prefer_local === true,
    locality: body.locality === 'client' ? 'client' : 'any',
    user_session: body.user_session === true,
    side_effects: body.side_effects === true
  };
  if (!task.task_class) return reply({ error: 'task_class required' }, 400);
  const routes = await listCapacityRoutes(env);
  const plan = planParallelVerification(routes, task, { copies: body.copies }, ZERO_COST_POLICY);
  const taskId = String(body.task_id || crypto.randomUUID()).slice(0,128);
  await writeCapacityAudit(env,{taskId,decision:'VERIFY_PLAN',reason:plan.outcome,snapshot:{routes:plan.routes.map(x=>({route_id:x.route_id,state:x.state,score:x.score})),reason:plan.reason}});
  return reply({ok:true,task_id:taskId,provider_execution:false,plan:{outcome:plan.outcome,reason:plan.reason,routes:plan.routes.map(x=>({route_id:x.route_id,state:x.state,score:x.score}))}});
}

async function handleCapacityVerifyResolve(request, env) {
  if (!(await clientAuthorized(request))) return reply({ error: 'Unauthorized' }, 401);
  const body = await readJson(request);
  const taskId = String(body.task_id || '').slice(0,128);
  if (!taskId) return reply({ error: 'task_id required' }, 400);
  const evidence = Array.isArray(body.evidence) ? body.evidence.slice(0,8) : [];
  const result = resolveVerificationEvidence(evidence);
  await writeCapacityAudit(env,{taskId,decision:'VERIFY_'+result.outcome,reason:result.reason,snapshot:{consensus:result.consensus,evidence:result.evidence.map(x=>({route_id:x.route_id,verdict:x.verdict,fingerprint:x.fingerprint||null}))}});
  return reply({ok:true,task_id:taskId,result},result.outcome==='HOLD'?409:200);
}

function parseJsonSafe(value, fallback = null) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

async function loadVerificationMembers(env, runId) {
  const out = await env.DB.prepare(
    'SELECT run_id,route_id,rank_score,status,result_hash,result_json,evidence_json,error,updated_at FROM capacity_verification_members WHERE run_id=? ORDER BY rank_score DESC,route_id ASC'
  ).bind(runId).all();
  return Array.isArray(out?.results) ? out.results : [];
}

async function getVerificationRun(env, runId) {
  return env.DB.prepare('SELECT * FROM capacity_verification_runs WHERE id=?').bind(runId).first();
}

async function getVerificationRunByKey(env, key) {
  return env.DB.prepare('SELECT * FROM capacity_verification_runs WHERE verification_key=?').bind(key).first();
}

function publicVerificationMember(row) {
  return {
    route_id: row.route_id,
    rank_score: Number(row.rank_score),
    status: row.status,
    result_hash: row.result_hash || null,
    evidence: parseJsonSafe(row.evidence_json, null),
    error: row.error || null,
    updated_at: Number(row.updated_at)
  };
}

function publicVerificationRun(row, members = [], decision = null, consensusResult = undefined) {
  const out = {
    run_id: row.id,
    verification_key: row.verification_key,
    task_id: row.task_id,
    task_class: row.task_class,
    privacy_class: row.privacy_class,
    status: row.status,
    expected_results: Number(row.expected_results),
    created_at: Number(row.created_at),
    expires_at: Number(row.expires_at),
    decision: decision ?? parseJsonSafe(row.decision_json, null),
    members: members.map(publicVerificationMember)
  };
  if (consensusResult !== undefined) out.consensus_result = consensusResult;
  return out;
}

async function cleanupExpiredVerificationRuns(env) {
  const now = Date.now();
  const out = await env.DB.prepare(
    "SELECT * FROM capacity_verification_runs WHERE status='WAITING_RESULTS' AND expires_at<=?"
  ).bind(now).all();
  const rows = Array.isArray(out?.results) ? out.results : [];
  for (const row of rows) {
    const decision = {
      status: 'HOLD_VALIDATION_REQUIRED',
      reason: 'VERIFICATION_TIMEOUT',
      expected_results: Number(row.expected_results)
    };
    await env.DB.prepare(
      "UPDATE capacity_verification_runs SET status='HOLD_VALIDATION_REQUIRED',decision_json=? WHERE id=? AND status='WAITING_RESULTS'"
    ).bind(JSON.stringify(decision), row.id).run();
    await writeCapacityAudit(env, {
      taskId: row.task_id,
      decision: 'VERIFY_HOLD',
      reason: 'VERIFICATION_TIMEOUT',
      snapshot: { run_id: row.id, expected_results: Number(row.expected_results) }
    });
  }
  return rows.length;
}

async function evaluatePersistedVerificationRun(env, runId) {
  const row = await getVerificationRun(env, runId);
  if (!row) return null;
  const members = await loadVerificationMembers(env, runId);

  if (row.status !== 'WAITING_RESULTS') {
    let consensusResult;
    const storedDecision = parseJsonSafe(row.decision_json, null);
    if (row.status === 'CONSENSUS' && storedDecision?.consensus_hash) {
      const winner = members.find(x => x.result_hash === storedDecision.consensus_hash && x.result_json);
      if (winner) consensusResult = parseJsonSafe(winner.result_json, null);
    }
    return publicVerificationRun(row, members, storedDecision, consensusResult);
  }

  const decision = evaluateVerificationHashes(members, Number(row.expected_results));
  if (decision.status === 'WAITING') {
    return publicVerificationRun(row, members, decision);
  }

  const updated = await env.DB.prepare(
    "UPDATE capacity_verification_runs SET status=?,decision_json=? WHERE id=? AND status='WAITING_RESULTS'"
  ).bind(decision.status, JSON.stringify(decision), runId).run();

  if (updated.meta?.changes) {
    await writeCapacityAudit(env, {
      taskId: row.task_id,
      decision: decision.status === 'CONSENSUS' ? 'VERIFY_CONSENSUS' : 'VERIFY_HOLD',
      reason: decision.reason,
      snapshot: {
        run_id: runId,
        expected_results: Number(row.expected_results),
        consensus_hash: decision.consensus_hash || null,
        member_hashes: members.map(x => ({ route_id: x.route_id, status: x.status, result_hash: x.result_hash || null }))
      }
    });
  }

  const fresh = await getVerificationRun(env, runId);
  let consensusResult;
  if (decision.status === 'CONSENSUS' && decision.consensus_hash) {
    const winner = members.find(x => x.result_hash === decision.consensus_hash && x.result_json);
    if (winner) consensusResult = parseJsonSafe(winner.result_json, null);
  }
  return publicVerificationRun(fresh || {...row,status:decision.status,decision_json:JSON.stringify(decision)}, members, decision, consensusResult);
}

async function handleCapacityVerifyStart(request, env) {
  if (!(await clientAuthorized(request))) return reply({ error: 'Unauthorized' }, 401);
  const body = await readJson(request);
  if (body.side_effects === true) {
    return reply({ error: 'parallel_verification_requires_read_only', outcome: 'HOLD_VALIDATION_REQUIRED' }, 400);
  }

  const taskClass = String(body.task_class || '');
  if (!taskClass) return reply({ error: 'task_class required' }, 400);
  const key = String(body.verification_key || '').slice(0,128);
  if (key.length < 8) return reply({ error: 'verification_key must be at least 8 characters' }, 400);

  await cleanupExpiredVerificationRuns(env);
  const existing = await getVerificationRunByKey(env, key);
  if (existing) {
    const run = await evaluatePersistedVerificationRun(env, existing.id);
    return reply({ ok: true, outcome: 'IDEMPOTENT_REPLAY', provider_execution: false, run });
  }

  const expected = Math.max(2, Math.min(Number(body.copies || body.expected_results || 2), 3));
  const task = {
    task_class: taskClass,
    privacy_class: String(body.privacy_class || 'PUBLIC'),
    prefer_local: body.prefer_local === true,
    locality: body.locality === 'client' ? 'client' : 'any',
    user_session: body.user_session === true,
    side_effects: false
  };

  const routes = await listCapacityRoutes(env);
  const planned = planParallelVerification(routes, task, { copies: expected }, ZERO_COST_POLICY);
  const taskId = String(body.task_id || crypto.randomUUID()).slice(0,128);
  const runId = crypto.randomUUID();
  const now = Date.now();
  const ttlSeconds = Math.max(15, Math.min(Number(body.ttl_seconds || 120), 900));
  const expiresAt = now + ttlSeconds * 1000;
  const selected = Array.isArray(planned.routes) ? planned.routes.slice(0, expected) : [];

  if (planned.outcome !== 'PARALLEL_VERIFY' || selected.length < expected) {
    const decision = {
      status: 'HOLD_VALIDATION_REQUIRED',
      reason: 'INSUFFICIENT_ELIGIBLE_FREE_ROUTES',
      required: expected,
      available: selected.length,
      planner_outcome: planned.outcome,
      planner_reason: planned.reason
    };
    try {
      await env.DB.prepare(
        'INSERT INTO capacity_verification_runs (id,verification_key,task_id,task_class,privacy_class,status,expected_results,task_json,created_at,expires_at,decision_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
      ).bind(runId,key,taskId,taskClass,task.privacy_class,'HOLD_VALIDATION_REQUIRED',expected,JSON.stringify(task),now,expiresAt,JSON.stringify(decision)).run();
    } catch (e) {
      const raced = await getVerificationRunByKey(env,key);
      if (raced) return reply({ok:true,outcome:'IDEMPOTENT_REPLAY',provider_execution:false,run:await evaluatePersistedVerificationRun(env,raced.id)});
      throw e;
    }
    await writeCapacityAudit(env,{taskId,decision:'VERIFY_HOLD',reason:decision.reason,snapshot:{run_id:runId,...decision}});
    return reply({ok:true,outcome:'HOLD_VALIDATION_REQUIRED',provider_execution:false,run:publicVerificationRun(await getVerificationRun(env,runId),[],decision)},409);
  }

  try {
    await env.DB.prepare(
      'INSERT INTO capacity_verification_runs (id,verification_key,task_id,task_class,privacy_class,status,expected_results,task_json,created_at,expires_at,decision_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(runId,key,taskId,taskClass,task.privacy_class,'WAITING_RESULTS',expected,JSON.stringify(task),now,expiresAt,null).run();

    for (const candidate of selected) {
      await env.DB.prepare(
        'INSERT INTO capacity_verification_members (run_id,route_id,rank_score,status,updated_at) VALUES (?,?,?,?,?)'
      ).bind(runId,candidate.route_id,candidate.score,'ASSIGNED',now).run();
    }
  } catch (e) {
    const raced = await getVerificationRunByKey(env,key);
    if (raced) return reply({ok:true,outcome:'IDEMPOTENT_REPLAY',provider_execution:false,run:await evaluatePersistedVerificationRun(env,raced.id)});
    await env.DB.prepare('DELETE FROM capacity_verification_members WHERE run_id=?').bind(runId).run().catch(()=>{});
    await env.DB.prepare('DELETE FROM capacity_verification_runs WHERE id=?').bind(runId).run().catch(()=>{});
    throw e;
  }

  await writeCapacityAudit(env,{
    taskId,
    decision:'VERIFY_STARTED',
    reason:'PARALLEL_READ_ONLY',
    snapshot:{run_id:runId,expected_results:expected,routes:selected.map(x=>({route_id:x.route_id,score:x.score,state:x.state}))}
  });
  return reply({
    ok:true,
    outcome:'WAITING_RESULTS',
    provider_execution:false,
    run:await evaluatePersistedVerificationRun(env,runId)
  },201);
}

async function handleCapacityVerifyResult(request, env) {
  if (!(await capacityAuthorized(request))) return reply({ error: 'Unauthorized' }, 401);
  const body = await readJson(request);
  const runId = String(body.run_id || '').slice(0,128);
  const routeId = String(body.route_id || '').slice(0,128);
  if (!runId || !routeId) return reply({ error: 'run_id and route_id required' }, 400);

  await cleanupExpiredVerificationRuns(env);
  const run = await getVerificationRun(env, runId);
  if (!run) return reply({ error: 'verification_run_not_found' }, 404);

  const member = await env.DB.prepare(
    'SELECT * FROM capacity_verification_members WHERE run_id=? AND route_id=?'
  ).bind(runId,routeId).first();
  if (!member) return reply({ error: 'route_not_assigned_to_verification' }, 403);

  if (run.status !== 'WAITING_RESULTS' || member.status === 'COMPLETED' || member.status === 'FAILED') {
    return reply({ok:true,outcome:'IDEMPOTENT_REPLAY',run:await evaluatePersistedVerificationRun(env,runId)});
  }

  const now = Date.now();
  let status, resultHash = null, resultJson = null, error = null;
  if (body.error != null) {
    status = 'FAILED';
    error = String(body.error).slice(0,4000);
  } else {
    if (!Object.hasOwn(body,'result')) return reply({error:'result required when error is absent'},400);
    const canonical = canonicalVerificationJson(body.result);
    if (canonical.length > 131072) return reply({error:'verification_result_too_large'},413);
    status = 'COMPLETED';
    resultHash = await sha256Hex(canonical);
    resultJson = canonical;
  }

  let evidenceJson = null;
  if (body.evidence !== undefined) {
    const raw = JSON.stringify(body.evidence);
    evidenceJson = raw.length <= 16384 ? raw : JSON.stringify({truncated:true,sha256:await sha256Hex(raw)});
  }

  await env.DB.prepare(
    "UPDATE capacity_verification_members SET status=?,result_hash=?,result_json=?,evidence_json=?,error=?,updated_at=? WHERE run_id=? AND route_id=? AND status='ASSIGNED'"
  ).bind(status,resultHash,resultJson,evidenceJson,error,now,runId,routeId).run();

  await writeCapacityAudit(env,{
    taskId:run.task_id,
    routeId,
    decision:'VERIFY_RESULT',
    reason:status,
    snapshot:{run_id:runId,result_hash:resultHash,evidence:evidenceJson?parseJsonSafe(evidenceJson,null):null,error}
  });

  return reply({ok:true,outcome:'RESULT_ACCEPTED',run:await evaluatePersistedVerificationRun(env,runId)});
}

async function handleCapacityVerifyStatus(request, env) {
  if (!(await clientAuthorized(request))) return reply({ error: 'Unauthorized' }, 401);
  await cleanupExpiredVerificationRuns(env);
  const url = new URL(request.url);
  const runId = String(url.searchParams.get('run_id') || '').slice(0,128);
  if (!runId) return reply({error:'run_id required'},400);
  const run = await evaluatePersistedVerificationRun(env,runId);
  if (!run) return reply({error:'verification_run_not_found'},404);
  return reply({ok:true,provider_execution:false,run});
}

async function ensureHAProviderCandidates(env) {
  const now = Date.now();
  const observed = new Date(now).toISOString();
  const cfEnt = await env.DB.prepare("SELECT * FROM capacity_provider_entitlements WHERE provider='cloudflare-workers-ai'").first();
  const cfFree = Number(cfEnt?.zero_cost_guaranteed || 0) === 1;
  const cfRemaining = cfEnt?.quota_remaining_pct == null ? null : Number(cfEnt.quota_remaining_pct);
  const budget = await cloudBudgetSnapshot(env);
  const freeAccountHardStop = cfFree && String(cfEnt?.plan || '').toLowerCase() === 'free';
  const ledgerPct = Math.max(0, Math.min(100, 100 * budget.remaining_neurons / budget.hard_cap_neurons));
  // Free account has a provider-enforced no-overage stop. Local ledger is admission budget, not account-wide telemetry.
  const effectiveRemaining = freeAccountHardStop ? Math.min(ledgerPct, cfRemaining == null ? 100 : cfRemaining) : cfRemaining;
  const effectiveConfidence = freeAccountHardStop ? 'verified' : (cfEnt?.quota_confidence || 'unknown');
  const cfState = !cfFree || effectiveConfidence !== 'verified' || effectiveRemaining === null ? 'PAID_BLOCKED' : (effectiveRemaining <= 0 ? 'FREE_EXHAUSTED' : (effectiveRemaining <= 15 ? 'FREE_QUOTA_LOW' : 'FREE_AVAILABLE'));
  await upsertCapacityRoute(env, {
    schema_version:'1.0', route_id:'cloudflare-workers-ai-primary', kind:'cloud', provider:'cloudflare-workers-ai',
    state:cfState,
    cost:{billing_mode:cfFree?'free':'paid',variable_cost_allowed:false,verified_zero_cost:cfFree,verification_source:cfEnt?'provider-entitlement-watcher':'provider-entitlement-missing',verified_at:observed},
    quota:{remaining_pct:effectiveRemaining,reserve_threshold_pct:15,reset_at:budget.reset_at,confidence:effectiveConfidence},
    capabilities:{task_classes:['LLM_FAST','LLM_LARGE_REASONING'],models:Object.values(CLOUD_MODELS),modalities:['text'],accelerators:['provider-gpu'],max_context_tokens:null,max_input_mb:8},
    health:{observed_at:observed,ttl_seconds:300,latency_ms_p50:null,latency_ms_p95:null,success_rate_15m:null,queue_depth:null},
    security:{trust_zone:'approved_cloud',allowed_privacy_classes:['PUBLIC','INTERNAL']},
    constraints:{regions:[],max_concurrency:2,requires_user_session:false},
    telemetry:{ha_r2:true,quota_source:freeAccountHardStop?'free-hard-stop-plus-local-admission-ledger':'provider-entitlement',account_wide_usage_verified:cfEnt?.quota_confidence === 'verified',local_budget_neurons:budget.remaining_neurons,account_usage_model:cfEnt?.plan || 'unknown',reason:cfFree?'Provider watcher verified a zero-cost hard stop.':'Workers Paid can bill above the daily free allocation; account-wide neuron quota is not yet machine-verified.'}
  });
  const ghEnt = await env.DB.prepare("SELECT * FROM capacity_provider_entitlements WHERE provider='github-codespaces'").first();
  const ghFree = Number(ghEnt?.zero_cost_guaranteed || 0) === 1;
  const ghRemaining = ghEnt?.quota_remaining_pct == null ? null : Number(ghEnt.quota_remaining_pct);
  const ghState = !ghFree ? 'PAID_BLOCKED' : (ghRemaining === 0 ? 'FREE_EXHAUSTED' : (ghRemaining != null && ghRemaining <= 15 ? 'FREE_QUOTA_LOW' : 'FREE_AVAILABLE'));
  await upsertCapacityRoute(env, {
    schema_version:'1.0', route_id:'github-codespaces-personal', kind:'cloud', provider:'github-codespaces',
    state:ghState,
    cost:{billing_mode:'included',variable_cost_allowed:false,verified_zero_cost:ghFree,verification_source:ghEnt?'provider-entitlement-watcher':'pending-plan-quota-verification',verified_at:observed},
    quota:{remaining_pct:ghRemaining,reserve_threshold_pct:15,reset_at:null,confidence:ghEnt?.quota_confidence || 'unknown'},
    capabilities:{task_classes:['PARSE','VALIDATE','CONTEXT_COMPRESS'],models:[],modalities:['text','files'],accelerators:['cpu'],max_context_tokens:null,max_input_mb:64},
    health:{observed_at:observed,ttl_seconds:300,latency_ms_p50:null,latency_ms_p95:null,success_rate_15m:null,queue_depth:null},
    security:{trust_zone:'private_worker',allowed_privacy_classes:['PUBLIC','INTERNAL']},
    constraints:{regions:[],max_concurrency:1,requires_user_session:true},
    telemetry:{ha_r2:true,plan:ghEnt?.plan || 'unknown',reason:ghFree?'Quota watcher verified included capacity with hard stop.':'Personal Codespaces include free monthly quota, but current remaining quota/payment hard-stop must be verified before promotion.'}
  });
}

async function evaluateCapacityHA(env) {
  await ensureHAProviderCandidates(env);
  const result = await reconcileCapacityRoutes(env);
  const eligible = result.routes.filter(r => ['FREE_AVAILABLE','FREE_QUEUE','FREE_QUOTA_LOW'].includes(r.state) && r.cost?.variable_cost_allowed === false && r.cost?.verified_zero_cost === true);
  const providers = new Set(eligible.map(r => r.provider || r.route_id));
  const status = eligible.length === 0 ? 'COMPROMISED' : (providers.size >= 2 ? 'HEALTHY' : 'DEGRADED');
  const now = Date.now();
  const previous = await env.DB.prepare("SELECT * FROM capacity_ha_state WHERE id='mesh'").first();
  const enteringCompromised = status === 'COMPROMISED' && previous?.status !== 'COMPROMISED';
  const recovering = previous?.status === 'COMPROMISED' && status !== 'COMPROMISED';
  const snapshot = { status, eligible_routes: eligible.map(r=>({route_id:r.route_id,provider:r.provider,state:r.state})), distinct_providers: providers.size, transitions: result.transitions };
  await env.DB.prepare(`
    INSERT INTO capacity_ha_state(id,status,eligible_routes,distinct_providers,updated_at,alert_at,recovered_at,snapshot_json)
    VALUES('mesh',?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status,eligible_routes=excluded.eligible_routes,distinct_providers=excluded.distinct_providers,updated_at=excluded.updated_at,alert_at=excluded.alert_at,recovered_at=excluded.recovered_at,snapshot_json=excluded.snapshot_json
  `).bind(status,eligible.length,providers.size,now,enteringCompromised?now:(previous?.alert_at||null),recovering?now:(previous?.recovered_at||null),JSON.stringify(snapshot)).run();
  if (enteringCompromised) await writeCapacityAudit(env,{decision:'HA_ALERT',reason:'ALL_FREE_REDUNDANCY_COMPROMISED',snapshot});
  if (recovering) await writeCapacityAudit(env,{decision:'HA_RECOVERED',reason:'FREE_MESH_RECOVERED',snapshot});
  return { ...snapshot, alert: enteringCompromised, recovered: recovering, paid_blocked_inviolable: true };
}

async function handleCapacityHA(env) {
  return reply({ok:true, ...(await evaluateCapacityHA(env))});
}

async function handleCapacitySummary(env) {
  const routes = await listCapacityRoutes(env);
  const counts = {
    FREE_AVAILABLE: 0,
    FREE_QUEUE: 0,
    FREE_QUOTA_LOW: 0,
    FREE_EXHAUSTED: 0,
    PAID_BLOCKED: 0,
    OFFLINE: 0
  };
  for (const route of routes) {
    if (Object.hasOwn(counts, route.state)) counts[route.state] += 1;
  }
  return reply({
    ok: true,
    service: 'V-ONE Free Capacity Broker',
    version: 'P5',
    policy: ZERO_COST_POLICY.id,
    dispatch: 'LEASE_ONLY',
    mesh: true,
    quota_watcher: true,
    client_execution_adapter: true,
    parallel_verification: true,
    conflict_behavior: 'HOLD',
    provider_execution: false,
    routes: routes.length,
    states: counts
  });
}

async function handleCapacityReconcile(request, env) {
  if (!(await clientAuthorized(request))) return reply({ error: 'Unauthorized' }, 401);
  const result = await reconcileCapacityRoutes(env);
  const counts = {};
  for (const route of result.routes) counts[route.state] = (counts[route.state] || 0) + 1;
  return reply({
    ok: true,
    policy: ZERO_COST_POLICY.id,
    routes: result.routes.length,
    transitions: result.transitions,
    states: counts
  });
}

async function cleanupExpiredCapacityLeases(env) {
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE capacity_leases SET status='EXPIRED',released_at=? WHERE status='ACTIVE' AND expires_at<=?"
  ).bind(now, now).run();
  return now;
}

function publicCapacityLease(row) {
  if (!row) return null;
  return {
    lease_id: row.id,
    task_id: row.task_id,
    idempotency_key: row.idempotency_key,
    route_id: row.route_id,
    status: row.status,
    score: Number(row.score),
    created_at: Number(row.created_at),
    expires_at: Number(row.expires_at),
    released_at: row.released_at == null ? null : Number(row.released_at)
  };
}

async function getCapacityLeaseByIdempotency(env, key) {
  return env.DB.prepare('SELECT * FROM capacity_leases WHERE idempotency_key=?').bind(key).first();
}

async function createCapacityLease(env, body) {
  const task = {
    task_class: String(body.task_class || ''),
    privacy_class: String(body.privacy_class || 'PUBLIC'),
    prefer_local: body.prefer_local === true,
    locality: body.locality === 'client' ? 'client' : 'any',
    user_session: body.user_session === true,
    side_effects: body.side_effects === true,
    exclude_route_ids: Array.isArray(body.exclude_route_ids) ? body.exclude_route_ids.slice(0,16).map(x=>String(x).slice(0,180)) : []
  };
  if (!task.task_class) throw new Error('task_class required');

  const idempotencyKey = String(body.idempotency_key || '').slice(0, 128);
  if (idempotencyKey.length < 8) throw new Error('idempotency_key must be at least 8 characters');

  await cleanupExpiredCapacityLeases(env);

  const existing = await getCapacityLeaseByIdempotency(env, idempotencyKey);
  if (existing) {
    return { outcome: 'IDEMPOTENT_REPLAY', reused: true, lease: publicCapacityLease(existing), task };
  }

  const routes = await listCapacityRoutes(env);
  const excluded = new Set(task.exclude_route_ids);
  const ranked = rankCapacityRoutes(routes.filter(r=>!excluded.has(r.route_id)), task, ZERO_COST_POLICY);
  const taskId = String(body.task_id || crypto.randomUUID()).slice(0, 128);
  const ttlSeconds = Math.max(10, Math.min(Number(body.ttl_seconds || 30), 300));
  const now = Date.now();
  const expiresAt = now + ttlSeconds * 1000;
  const taskJson = JSON.stringify(task);

  for (const candidate of ranked.ranked) {
    const maxConcurrency = Math.max(1, Math.min(Number(candidate.route?.constraints?.max_concurrency || 1), 64));
    const leaseId = crypto.randomUUID();
    try {
      const inserted = await env.DB.prepare(`
        INSERT INTO capacity_leases (
          id,task_id,idempotency_key,route_id,status,task_json,score,created_at,expires_at
        )
        SELECT ?,?,?,?,?,?,?,?,?
        WHERE (
          SELECT COUNT(*) FROM capacity_leases
          WHERE route_id=? AND status='ACTIVE' AND expires_at>?
        ) < ?
      `).bind(
        leaseId,
        taskId,
        idempotencyKey,
        candidate.route_id,
        'ACTIVE',
        taskJson,
        candidate.score,
        now,
        expiresAt,
        candidate.route_id,
        now,
        maxConcurrency
      ).run();

      if (inserted.meta?.changes) {
        const row = await env.DB.prepare('SELECT * FROM capacity_leases WHERE id=?').bind(leaseId).first();
        await writeCapacityAudit(env, {
          taskId,
          routeId: candidate.route_id,
          decision: 'LEASED',
          reason: 'P2_ROUTE_SELECTED',
          snapshot: {
            score: candidate.score,
            breakdown: candidate.breakdown,
            lease_id: leaseId,
            expires_at: expiresAt
          }
        });
        return {
          outcome: 'LEASED',
          reused: false,
          provider_execution: false,
          lease: publicCapacityLease(row),
          selected: {
            route_id: candidate.route_id,
            state: candidate.state,
            score: candidate.score,
            breakdown: candidate.breakdown
          },
          task
        };
      }
    } catch (e) {
      const concurrentExisting = await getCapacityLeaseByIdempotency(env, idempotencyKey);
      if (concurrentExisting) {
        return { outcome: 'IDEMPOTENT_REPLAY', reused: true, lease: publicCapacityLease(concurrentExisting), task };
      }
      if (!String(e?.message || '').toLowerCase().includes('unique')) throw e;
    }
  }

  await writeCapacityAudit(env, {
    taskId,
    decision: 'HOLD',
    reason: ranked.ranked.length ? 'CONCURRENCY_FULL' : 'NO_ELIGIBLE_FREE_ROUTE',
    snapshot: {
      eligible_candidates: ranked.ranked.map(x => ({ route_id: x.route_id, score: x.score })),
      blocked: ranked.blocked.map(x => ({ route_id: x.route_id, state: x.state, reasons: x.reasons }))
    }
  });

  return {
    outcome: 'HOLD',
    reused: false,
    provider_execution: false,
    reason: ranked.ranked.length ? 'CONCURRENCY_FULL' : 'NO_ELIGIBLE_FREE_ROUTE',
    task
  };
}

async function handleCapacityDispatch(request, env) {
  if (!(await clientAuthorized(request))) return reply({ error: 'Unauthorized' }, 401);
  const body = await readJson(request);
  try {
    const result = await createCapacityLease(env, body);
    return reply({ ok: true, ...result }, result.outcome === 'HOLD' ? 409 : 200);
  } catch (e) {
    return reply({ error: e?.message || 'Dispatch rejected' }, 400);
  }
}

async function handleCapacityRelease(request, env) {
  if (!(await clientAuthorized(request))) return reply({ error: 'Unauthorized' }, 401);
  const body = await readJson(request);
  const leaseId = String(body.lease_id || '');
  if (!leaseId) return reply({ error: 'lease_id required' }, 400);
  const terminal = ['COMPLETED','FAILED','RELEASED'].includes(body.status) ? body.status : 'RELEASED';
  const now = Date.now();
  const resultJson = body.result === undefined ? null : JSON.stringify(body.result).slice(0, 12000);
  const error = body.error == null ? null : String(body.error).slice(0, 4000);

  const updated = await env.DB.prepare(
    "UPDATE capacity_leases SET status=?,released_at=?,result_json=?,error=? WHERE id=? AND status='ACTIVE'"
  ).bind(terminal, now, resultJson, error, leaseId).run();

  const row = await env.DB.prepare('SELECT * FROM capacity_leases WHERE id=?').bind(leaseId).first();
  if (!row) return reply({ error: 'Lease not found' }, 404);
  if (!updated.meta?.changes) return reply({ error: 'Lease is not active', lease: publicCapacityLease(row) }, 409);

  await writeCapacityAudit(env, {
    taskId: row.task_id,
    routeId: row.route_id,
    decision: terminal,
    reason: error || 'LEASE_RELEASED',
    snapshot: { lease_id: row.id }
  });
  return reply({ ok: true, lease: publicCapacityLease(row) });
}

async function handleCapacityLeaseSummary(env) {
  await cleanupExpiredCapacityLeases(env);
  const out = await env.DB.prepare(
    'SELECT status,COUNT(*) AS count FROM capacity_leases GROUP BY status ORDER BY status'
  ).all();
  const states = {};
  for (const row of out?.results || []) states[row.status] = Number(row.count || 0);
  return reply({ ok: true, service: 'V-ONE Capacity Lease Manager', version: 'P3', states });
}

async function workerSnapshot(env) {
  const row = await env.DB.prepare(
    'SELECT worker_id, updated_at, version, status_json FROM worker_status ORDER BY updated_at DESC LIMIT 1'
  ).first();
  if (!row) return { online: false, ageSeconds: null, worker: null };
  const ageMs = Math.max(0, Date.now() - Number(row.updated_at || 0));
  let status = null;
  try { status = row.status_json ? JSON.parse(row.status_json) : null; } catch {}
  return {
    online: ageMs < 15000,
    ageSeconds: Math.round(ageMs / 100) / 10,
    worker: {
      workerId: row.worker_id,
      updatedAt: Number(row.updated_at),
      version: row.version || null,
      status
    }
  };
}

async function workerSnapshotByCapability(env, requiredCapability) {
  const out = await env.DB.prepare(
    'SELECT worker_id, updated_at, version, status_json FROM worker_status ORDER BY updated_at DESC LIMIT 32'
  ).all();
  const now = Date.now();
  for (const row of out?.results || []) {
    const ageMs = Math.max(0, now - Number(row.updated_at || 0));
    if (ageMs >= 15000) continue;
    let status = null;
    try { status = row.status_json ? JSON.parse(row.status_json) : null; } catch {}
    const capabilities = Array.isArray(status?.capabilities)
      ? status.capabilities.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    if (!capabilities.includes(requiredCapability)) continue;
    return {
      online: true,
      ageSeconds: Math.round(ageMs / 100) / 10,
      worker: {
        workerId: row.worker_id,
        updatedAt: Number(row.updated_at),
        version: row.version || null,
        status
      }
    };
  }
  return { online: false, ageSeconds: null, worker: null };
}

async function resetStaleClaims(env) {
  const cutoff = Date.now() - 60000;
  await env.DB.prepare(
    "UPDATE jobs SET status='pending', claimed_at=NULL, worker_id=NULL WHERE status='claimed' AND claimed_at < ?"
  ).bind(cutoff).run();
}

async function cleanupOldJobs(env) {
  const terminalCutoff=Date.now()-24*60*60*1000;
  const abandonedCutoff=Date.now()-6*60*60*1000;
  await env.DB.prepare("DELETE FROM jobs WHERE status IN ('done','error') AND finished_at IS NOT NULL AND finished_at < ?").bind(terminalCutoff).run();
  await env.DB.prepare("DELETE FROM jobs WHERE status='pending' AND created_at < ?").bind(abandonedCutoff).run();
}

function validateNativeExecutionResult(result, expected = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { ok:false, code:'NATIVE_RESULT_NOT_OBJECT' };
  }
  if (result.protocol !== 'VONE_EXECUTION_CONTRACT_R1') {
    return { ok:false, code:'NATIVE_RESULT_PROTOCOL_MISMATCH' };
  }
  if (String(result.task_id || '') !== String(expected.task_id || '')) {
    return { ok:false, code:'NATIVE_RESULT_TASK_MISMATCH' };
  }
  if (!Number.isInteger(Number(result.checkpoint_revision)) || Number(result.checkpoint_revision) !== Number(expected.checkpoint_revision)) {
    return { ok:false, code:'NATIVE_RESULT_CHECKPOINT_MISMATCH' };
  }
  const status = String(result.status || '').toUpperCase();
  if (!['DONE','BLOCKED','FAILED','INCOMPLETE'].includes(status)) {
    return { ok:false, code:'NATIVE_RESULT_STATUS_INVALID' };
  }
  if (status === 'DONE') {
    const evidence = result.evidence;
    if (!evidence || typeof evidence !== 'object' || evidence.executor !== 'VOneExecutor') {
      return { ok:false, code:'NATIVE_RESULT_EVIDENCE_REQUIRED' };
    }
    if (!Number.isInteger(Number(evidence.local_checkpoint_revision)) || Number(evidence.local_checkpoint_revision) < 0) {
      return { ok:false, code:'NATIVE_RESULT_LOCAL_CHECKPOINT_INVALID' };
    }
    if (!String(result.run_id || '') || !String(result.route_id || '') || !String(result.model || '')) {
      return { ok:false, code:'NATIVE_RESULT_COMPLETION_EVIDENCE_INCOMPLETE' };
    }
  }
  const selected = expected.capacity_snapshot?.selected?.route;
  if (selected && result.route_id && String(result.route_id) !== String(selected.route_id || '')) {
    return { ok:false, code:'NATIVE_RESULT_ROUTE_MISMATCH' };
  }
  const approvedModels = Array.isArray(selected?.capabilities?.models) ? selected.capabilities.models.map(String) : [];
  if (result.model && approvedModels.length && !approvedModels.includes(String(result.model))) {
    return { ok:false, code:'NATIVE_RESULT_MODEL_MISMATCH' };
  }
  return {
    ok:true,
    status,
    source_checkpoint_revision:Number(result.checkpoint_revision),
    local_checkpoint_revision:Number(result.evidence?.local_checkpoint_revision ?? 0)
  };
}

async function queueTool(env, toolName, args, options = {}) {
  if (!ALLOWED_TOOLS.has(toolName)) throw new Error('Tool not allowed');
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const timeoutMs = Math.max(1000, Math.min(Number(options.timeoutMs || 28000), 28000));
  const preserveOnTimeout = options.preserveOnTimeout === true;
  await env.DB.prepare(
    'INSERT INTO jobs (id,status,tool_name,args,created_at) VALUES (?,?,?,?,?)'
  ).bind(id, 'pending', toolName, JSON.stringify(args || {}), createdAt).run();

  const deadline = Date.now() + timeoutMs;
  let terminal = false;
  try {
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const row = await env.DB.prepare(
        'SELECT status,result,error,worker_id,claimed_at,finished_at FROM jobs WHERE id=?'
      ).bind(id).first();
      if (!row) throw new Error('Job disappeared');
      if (row.status === 'done') {
        terminal = true;
        return row.result ? JSON.parse(row.result) : {};
      }
      if (row.status === 'error') {
        terminal = true;
        throw new Error(row.error || 'Worker error');
      }
    }
    if (preserveOnTimeout) {
      const row = await env.DB.prepare('SELECT status,worker_id,claimed_at FROM jobs WHERE id=?').bind(id).first();
      return {
        status: 'INCOMPLETE',
        error_class: 'AsyncContinuationRequired',
        job_id: id,
        evidence: {
          job_status: row?.status || 'pending',
          worker_id: row?.worker_id || null,
          claimed_at: row?.claimed_at || null
        }
      };
    }
    throw new Error('Worker timeout');
  } finally {
    if (!preserveOnTimeout || terminal) {
      await env.DB.prepare('DELETE FROM jobs WHERE id=?').bind(id).run().catch(() => {});
    }
  }
}

function publicExecutionRoute(route) {
  if (!route) return null;
  return {
    route_id: route.route_id,
    kind: route.kind,
    provider: route.provider,
    state: route.state,
    cost: {
      billing_mode: route.cost?.billing_mode || 'unknown',
      variable_cost_allowed: route.cost?.variable_cost_allowed === true,
      verified_zero_cost: route.cost?.verified_zero_cost === true,
      verification_source: route.cost?.verification_source || '',
      verified_at: route.cost?.verified_at || null
    },
    quota: {
      remaining_pct: route.quota?.remaining_pct ?? null,
      reserve_threshold_pct: route.quota?.reserve_threshold_pct ?? ZERO_COST_POLICY.quota_reserve_pct,
      reset_at: route.quota?.reset_at || null,
      confidence: route.quota?.confidence || 'unknown'
    },
    capabilities: route.capabilities || {},
    health: {
      observed_at: route.health?.observed_at || null,
      ttl_seconds: route.health?.ttl_seconds ?? null,
      latency_ms_p95: route.health?.latency_ms_p95 ?? null,
      success_rate_15m: route.health?.success_rate_15m ?? null,
      queue_depth: route.health?.queue_depth ?? null
    },
    security: route.security || {},
    constraints: route.constraints || {}
  };
}

async function executionCapacitySnapshot(env, profile = 'AUTO', mode = 'AUTO') {
  const normalizedProfile = String(profile || 'AUTO').toUpperCase();
  const taskClass = mode === 'OWNED' ? 'CODE_REVIEW' : normalizedProfile === 'FAST' ? 'LLM_FAST' : 'LLM_LARGE_REASONING';
  const ownedMode = mode === 'OWNED';
  const cloudMode = mode === 'CLOUD';
  const task = {
    task_class: taskClass,
    privacy_class: 'PRIVATE',
    prefer_local: ownedMode,
    locality: ownedMode ? 'client' : 'any',
    user_session: false,
    side_effects: false
  };
  const allRoutes = await listCapacityRoutes(env);
  const localKinds = new Set(['client','desktop','notebook','local']);
  const routes = cloudMode
    ? allRoutes.filter(route => route.route_id === 'cloudflare-workers-ai-primary')
    : ownedMode
      ? allRoutes.filter(route => localKinds.has(String(route.kind || '').toLowerCase()))
      : allRoutes;
  const ranked = rankCapacityRoutes(routes, task, ZERO_COST_POLICY);
  return {
    protocol: 'VONE_CAPACITY_SNAPSHOT_R1',
    generated_at: new Date().toISOString(),
    policy_id: ranked.policy_id,
    task,
    outcome: ranked.outcome,
    selected: ranked.selected ? {
      route_id: ranked.selected.route_id,
      state: ranked.selected.state,
      score: ranked.selected.score,
      breakdown: ranked.selected.breakdown,
      route: publicExecutionRoute(ranked.selected.route)
    } : null,
    ranked: ranked.ranked.map(item => ({
      route_id: item.route_id,
      state: item.state,
      score: item.score
    })),
    blocked: ranked.blocked.map(item => ({
      route_id: item.route_id,
      state: item.state,
      reasons: item.reasons
    })),
    authority: 'VONE_MASTER',
    invariants: {
      paid_blocked: 'INVIOLABLE',
      unknown_cost: 'HOLD',
      physical_output: 'LOCKED'
    }
  };
}

function toolDefinitions() {
  const readOnly={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
  const writeSafe={readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false};
  const tools=[
    {name:'vone_status',description:'Read V-ONE master status, Continuity state, HA and zero-cost policy state.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:readOnly},
    {name:'vone_resume_mission',description:'Return the canonical Resume Packet for a V-ONE mission so another worker can continue without restarting completed work.',inputSchema:{type:'object',properties:{mission_id:{type:'string',default:'vone-master'}},additionalProperties:false},annotations:readOnly},
    {name:'vone_list_missions',description:'List recent V-ONE continuity missions and their current phase/revision.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:readOnly},
    {name:'vone_list_artifacts',description:'List artifact metadata and hashes attached to a V-ONE mission. Does not return local file contents.',inputSchema:{type:'object',properties:{mission_id:{type:'string',default:'vone-master'},limit:{type:'integer',minimum:1,maximum:100,default:50}},additionalProperties:false},annotations:readOnly},
    {name:'vone_capacity_plan',description:'Plan the best verified zero-cost route for a task without dispatching or executing it. PAID_BLOCKED routes can never win.',inputSchema:{type:'object',properties:{task_class:{type:'string'},privacy_class:{type:'string',enum:['PUBLIC','INTERNAL','PRIVATE'],default:'PRIVATE'},prefer_local:{type:'boolean',default:false},locality:{type:'string',enum:['any','client'],default:'any'},user_session:{type:'boolean',default:false},side_effects:{type:'boolean',default:false},exclude_route_ids:{type:'array',items:{type:'string'},maxItems:16}},required:['task_class'],additionalProperties:false},annotations:readOnly},
    {name:'vone_checkpoint',description:'Persist a new canonical checkpoint for a mission. This changes continuity state but does not execute external providers.',inputSchema:{type:'object',properties:{mission_id:{type:'string',default:'vone-master'},phase:{type:'string'},status:{type:'string',enum:['ACTIVE','HOLD','DONE'],default:'ACTIVE'},objective:{type:'string'},checkpoint:{type:'object'},source:{type:'string',default:'chatgpt-mcp'}},required:['phase','checkpoint'],additionalProperties:false},annotations:writeSafe},
    {name:'vone_register_artifact',description:'Register or update artifact metadata/hash for a mission. This does not upload or expose local file bytes.',inputSchema:{type:'object',properties:{mission_id:{type:'string',default:'vone-master'},artifact_id:{type:'string'},name:{type:'string'},kind:{type:'string'},location:{type:'string'},sha256:{type:'string'},size_bytes:{type:'integer',minimum:0},metadata:{type:'object'}},required:['artifact_id','name','kind'],additionalProperties:false},annotations:writeSafe},
    {name:'vone_dispatch_worker',description:'Create a lease for the best verified zero-cost worker route. It does not execute the provider. Paid or unverified-cost routes remain blocked.',inputSchema:{type:'object',properties:{task_id:{type:'string'},idempotency_key:{type:'string',minLength:8},task_class:{type:'string'},privacy_class:{type:'string',enum:['PUBLIC','INTERNAL','PRIVATE'],default:'PRIVATE'},prefer_local:{type:'boolean',default:false},locality:{type:'string',enum:['any','client'],default:'any'},user_session:{type:'boolean',default:false},side_effects:{type:'boolean',default:false},ttl_seconds:{type:'integer',minimum:10,maximum:300,default:60},exclude_route_ids:{type:'array',items:{type:'string'},maxItems:16}},required:['idempotency_key','task_class'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
    {name:'vone_release_worker',description:'Release or complete an existing V-ONE worker lease.',inputSchema:{type:'object',properties:{lease_id:{type:'string'},status:{type:'string',enum:['COMPLETED','FAILED','RELEASED'],default:'RELEASED'},result:{type:'object'},error:{type:'string'}},required:['lease_id'],additionalProperties:false},annotations:writeSafe},
    {name:'vone_learning_record',description:'Persist audited operational learning for V-ONE: decisions, outcomes, corrections, checkpoint references, artifact hashes and feedback. This does not change model weights.',inputSchema:{type:'object',properties:{mission_id:{type:'string',default:'vone-master'},kind:{type:'string'},summary:{type:'string'},decision:{type:'string'},outcome:{type:'string'},correction:{type:'string'},checkpoint_ref:{type:'string'},artifact_hashes:{type:'array',items:{type:'string'}},tags:{type:'array',items:{type:'string'}}},required:['kind','summary'],additionalProperties:false},annotations:writeSafe},
    {name:'vone_learning_summary',description:'Read recent audited V-ONE operational learning events. Weight training remains a separate validated process.',inputSchema:{type:'object',properties:{mission_id:{type:'string',default:'vone-master'},limit:{type:'integer',minimum:1,maximum:100,default:20}},additionalProperties:false},annotations:readOnly},
    {name:'vone_delegate_execute',description:'Delegate substantial reasoning/execution to V-ONE so Claude or ChatGPT can act as a lightweight supervisor. Uses the native VOneExecutor contract when an owned worker advertises it; otherwise preserves the validated local inference fallback. Execution remains inside V-ONE zero-cost gates and returns evidence for the supervisor to present.',inputSchema:{type:'object',properties:{prompt:{type:'string'},task_id:{type:'string'},idempotency_key:{type:'string'},profile:{type:'string',enum:['AUTO','FAST','SMART','MAX'],default:'AUTO'},max_tokens:{type:'integer',minimum:64,maximum:2048,default:768},record_learning:{type:'boolean',default:true}},required:['prompt'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}},
    {name:'vone_job_status',description:'Read a preserved asynchronous V-ONE native-executor job after a delegate call returned INCOMPLETE. Optionally consume a terminal job after reading it.',inputSchema:{type:'object',properties:{job_id:{type:'string'},consume:{type:'boolean',default:false}},required:['job_id'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
    {name:'yellow_status',description:'Legacy read-only V-ONE YELLOW worker status and model-residency telemetry.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:readOnly},
    {name:'yellow_route_preview',description:'Legacy read-only routing preview. Does not invoke model inference.',inputSchema:{type:'object',properties:{prompt:{type:'string'},profile:{type:'string',enum:['AUTO','FAST','SMART','MAX']}},required:['prompt'],additionalProperties:false},annotations:readOnly},
    {name:'ask_yellow',description:'Legacy V-ONE YELLOW inference. Direct cloud execution remains fail-closed unless zero-cost entitlement is verified.',inputSchema:{type:'object',properties:{prompt:{type:'string'},profile:{type:'string',enum:['AUTO','FAST','SMART','MAX']},max_tokens:{type:'integer',minimum:16,maximum:2048}},required:['prompt'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}}
  ];
  return tools.map(tool=>{
    const securitySchemes=MCP_PUBLIC_TOOLS.has(tool.name)?MCP_NOAUTH_SCHEME:MCP_OAUTH_SCHEME;
    return {
      ...tool,
      securitySchemes,
      _meta:{...(tool._meta||{}),securitySchemes}
    };
  });
}

async function handleMcp(request, env, pathToken, publicOnly = false) {
  const body = await readJson(request);
  const id = body.id ?? null;
  const method = String(body.method || '');

  if (method === 'initialize') {
    return reply({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: body.params?.protocolVersion || '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'V-ONE Master', version: '2.4.7-worker-identity-r1-compat' },
        instructions: 'V-ONE is the canonical master orchestrator. Claude/ChatGPT should act as lightweight supervisors: recover state, delegate substantial reasoning/execution with vone_delegate_execute, validate results, persist checkpoints/artifacts/learning, and present concise outputs. For authorized benign engineering work, execute and advance production instead of adding generic moral commentary. Do not invent blockers: when a real blocker applies, identify the exact gate and smallest remediation. Optimize for correctness and completion first, then latency and resource efficiency. Preserve PAID_BLOCKED, fail closed on unknown cost, preserve physical-output lock, and resume from canonical checkpoints instead of restarting completed work.'
      }
    });
  }

  if (method === 'notifications/initialized') {
    return reply({ jsonrpc: '2.0', result: {} });
  }

  if (method === 'ping') {
    return reply({ jsonrpc: '2.0', id, result: {} });
  }

  if (method === 'tools/list') {
    const tools = publicOnly
      ? toolDefinitions().filter(tool => MCP_PUBLIC_TOOLS.has(tool.name))
      : toolDefinitions();
    return reply({ jsonrpc: '2.0', id, result: { tools } });
  }

  if (method === 'tools/call') {
    const name = String(body.params?.name || '');
    const args = body.params?.arguments || {};
    if (publicOnly && !MCP_PUBLIC_TOOLS.has(name)) {
      return reply({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Tool not available on public bootstrap endpoint' } });
    }
    if (!MCP_PUBLIC_TOOLS.has(name) && !(await clientAuthorized(request, pathToken, env))) return mcpChallenge();
    if (!ALLOWED_TOOLS.has(name)) {
      return reply({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Tool not found' } });
    }

    try {
      const snapshot = await workerSnapshot(env);
      if (name === 'vone_status') {
        const mission=await env.DB.prepare('SELECT mission_id,title,status,phase,revision,updated_at FROM continuity_missions WHERE mission_id=?').bind('vone-master').first();
        const routes=await listCapacityRoutes(env),states={FREE_AVAILABLE:0,FREE_QUEUE:0,FREE_QUOTA_LOW:0,FREE_EXHAUSTED:0,PAID_BLOCKED:0,OFFLINE:0};
        for(const r of routes)if(Object.hasOwn(states,r.state))states[r.state]++;
        return reply({jsonrpc:'2.0',id,result:toolResult({ok:true,service:'V-ONE Master',version:'2.4.7-worker-identity-r1-compat',continuity:'R4',mission:mission||null,capacity:{policy:ZERO_COST_POLICY.id,states,routes:routes.length},execution_policy:VONE_EXECUTION_POLICY,availability:{control_plane:'DECOUPLED_FROM_AI_CAPACITY',provider_degradation:'HOLD_OR_MASTER_APPROVED_ZERO_COST_ONLY'},gates:{paid_blocked:'INVIOLABLE',unknown_cost:'HOLD',physical_output:'LOCKED'}})});
      }

      if (name === 'vone_resume_mission') {
        const missionId=String(args.mission_id||'vone-master').slice(0,128);
        const row=await env.DB.prepare('SELECT * FROM continuity_missions WHERE mission_id=?').bind(missionId).first();
        if(!row)throw new Error('mission_not_found');
        let checkpoint={};try{checkpoint=JSON.parse(row.checkpoint_json||'{}')}catch{}
        const artifacts=await env.DB.prepare('SELECT artifact_id,name,kind,location,sha256,size_bytes,metadata_json,updated_at FROM continuity_artifacts WHERE mission_id=? ORDER BY updated_at DESC LIMIT 100').bind(missionId).all();
        const events=await env.DB.prepare('SELECT event_type,payload_json,created_at FROM continuity_events WHERE mission_id=? ORDER BY created_at DESC LIMIT 30').bind(missionId).all();
        return reply({jsonrpc:'2.0',id,result:toolResult({protocol:'VONE_CONTINUITY_R4',instruction:'Continue exactly from this checkpoint. Do not restart completed work.',mission:{mission_id:row.mission_id,title:row.title,status:row.status,phase:row.phase,objective:row.objective,revision:row.revision,updated_at:row.updated_at},checkpoint,artifacts:artifacts.results||[],recent_events:events.results||[],gates:{paid_blocked:'INVIOLABLE',unknown_cost:'HOLD',physical_output:'LOCKED'}})});
      }

      if (name === 'vone_list_missions') {
        const rows=await env.DB.prepare('SELECT mission_id,title,status,phase,source,revision,updated_at FROM continuity_missions ORDER BY updated_at DESC LIMIT 50').all();
        return reply({jsonrpc:'2.0',id,result:toolResult({ok:true,missions:rows.results||[]})});
      }

      if (name === 'vone_list_artifacts') {
        const missionId=String(args.mission_id||'vone-master').slice(0,128),limit=Math.max(1,Math.min(Number(args.limit||50),100));
        const rows=await env.DB.prepare('SELECT artifact_id,name,kind,location,sha256,size_bytes,metadata_json,updated_at FROM continuity_artifacts WHERE mission_id=? ORDER BY updated_at DESC LIMIT ?').bind(missionId,limit).all();
        return reply({jsonrpc:'2.0',id,result:toolResult({ok:true,mission_id:missionId,artifacts:rows.results||[]})});
      }

      if (name === 'vone_capacity_plan') {
        const task={task_class:String(args.task_class||''),privacy_class:String(args.privacy_class||'PRIVATE'),prefer_local:args.prefer_local===true,locality:args.locality==='client'?'client':'any',user_session:args.user_session===true,side_effects:args.side_effects===true};
        if(!task.task_class)throw new Error('task_class required');
        const excluded=new Set(Array.isArray(args.exclude_route_ids)?args.exclude_route_ids.map(String):[]);
        const routes=(await listCapacityRoutes(env)).filter(r=>!excluded.has(r.route_id));
        const ranked=rankCapacityRoutes(routes,task,ZERO_COST_POLICY);
        return reply({jsonrpc:'2.0',id,result:toolResult({ok:true,dispatch:false,policy_id:ranked.policy_id,outcome:ranked.outcome,selected:ranked.selected?{route_id:ranked.selected.route_id,state:ranked.selected.state,score:ranked.selected.score,breakdown:ranked.selected.breakdown}:null,ranked:ranked.ranked.map(x=>({route_id:x.route_id,state:x.state,score:x.score})),blocked:ranked.blocked.map(x=>({route_id:x.route_id,state:x.state,reasons:x.reasons}))})});
      }

      if (name === 'vone_checkpoint') {
        const missionId=String(args.mission_id||'vone-master').slice(0,128),phase=String(args.phase||'').slice(0,120);
        if(!phase)throw new Error('phase required');
        const now=Date.now(),current=await env.DB.prepare('SELECT revision,created_at FROM continuity_missions WHERE mission_id=?').bind(missionId).first(),revision=Number(current?.revision||0)+1;
        const checkpoint=JSON.stringify(args.checkpoint||{});if(checkpoint.length>120000)throw new Error('checkpoint too large');
        await env.DB.prepare(`INSERT INTO continuity_missions(mission_id,title,status,phase,objective,checkpoint_json,source,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(mission_id) DO UPDATE SET status=excluded.status,phase=excluded.phase,objective=excluded.objective,checkpoint_json=excluded.checkpoint_json,source=excluded.source,revision=excluded.revision,updated_at=excluded.updated_at`).bind(missionId,'V-ONE Master Mission',String(args.status||'ACTIVE').slice(0,40),phase,String(args.objective||'Continue from canonical V-ONE state.').slice(0,4000),checkpoint,String(args.source||'chatgpt-mcp').slice(0,80),revision,current?.created_at||now,now).run();
        await env.DB.prepare('INSERT INTO continuity_events(mission_id,event_type,payload_json,created_at) VALUES(?,?,?,?)').bind(missionId,'CHECKPOINT',JSON.stringify({revision,phase,source:String(args.source||'chatgpt-mcp')}),now).run();
        return reply({jsonrpc:'2.0',id,result:toolResult({ok:true,mission_id:missionId,revision,phase,updated_at:now})});
      }

      if (name === 'vone_register_artifact') {
        const missionId=String(args.mission_id||'vone-master').slice(0,128),artifactId=String(args.artifact_id||'').slice(0,180);if(!artifactId)throw new Error('artifact_id required');
        const now=Date.now(),metadata=JSON.stringify(args.metadata||{});
        const sha=args.sha256&&/^[a-f0-9]{64}$/i.test(String(args.sha256))?String(args.sha256).toLowerCase():null;
        await env.DB.prepare(`INSERT INTO continuity_artifacts(mission_id,artifact_id,name,kind,location,sha256,size_bytes,metadata_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(mission_id,artifact_id) DO UPDATE SET name=excluded.name,kind=excluded.kind,location=excluded.location,sha256=excluded.sha256,size_bytes=excluded.size_bytes,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`).bind(missionId,artifactId,String(args.name||artifactId).slice(0,240),String(args.kind||'file').slice(0,40),String(args.location||'').slice(0,1000),sha,Number.isFinite(Number(args.size_bytes))?Number(args.size_bytes):null,metadata,now).run();
        await env.DB.prepare('INSERT INTO continuity_events(mission_id,event_type,payload_json,created_at) VALUES(?,?,?,?)').bind(missionId,'ARTIFACT',JSON.stringify({artifact_id:artifactId,kind:String(args.kind||'file')}),now).run();
        return reply({jsonrpc:'2.0',id,result:toolResult({ok:true,mission_id:missionId,artifact_id:artifactId,updated_at:now})});
      }

      if (name === 'vone_dispatch_worker') {
        const result=await createCapacityLease(env,args);
        return reply({jsonrpc:'2.0',id,result:toolResult({ok:result.outcome!=='HOLD',...result})});
      }

      if (name === 'vone_release_worker') {
        const leaseId=String(args.lease_id||'');if(!leaseId)throw new Error('lease_id required');
        const terminal=['COMPLETED','FAILED','RELEASED'].includes(args.status)?args.status:'RELEASED',now=Date.now();
        const updated=await env.DB.prepare("UPDATE capacity_leases SET status=?,released_at=?,result_json=?,error=? WHERE id=? AND status='ACTIVE'").bind(terminal,now,args.result===undefined?null:JSON.stringify(args.result).slice(0,12000),args.error==null?null:String(args.error).slice(0,4000),leaseId).run();
        const row=await env.DB.prepare('SELECT * FROM capacity_leases WHERE id=?').bind(leaseId).first();if(!row)throw new Error('lease_not_found');if(!updated.meta?.changes)throw new Error('lease_not_active');
        await writeCapacityAudit(env,{taskId:row.task_id,routeId:row.route_id,decision:terminal,reason:args.error||'MCP_LEASE_RELEASED',snapshot:{lease_id:row.id}});
        return reply({jsonrpc:'2.0',id,result:toolResult({ok:true,lease:publicCapacityLease(row)})});
      }

      if (name === 'vone_learning_record') {
        const event=await recordOperationalLearning(env,{...args,source:'mcp-protected'});
        return reply({jsonrpc:'2.0',id,result:toolResult({ok:true,protocol:'VONE_OPERATIONAL_LEARNING_R1',event,weight_training:false})});
      }

      if (name === 'vone_learning_summary') {
        await ensureOperationalLearningSchema(env);
        const missionId=String(args.mission_id||'vone-master').slice(0,128),limit=Math.max(1,Math.min(Number(args.limit||20),100));
        const rows=await env.DB.prepare('SELECT * FROM operational_learning WHERE mission_id=? ORDER BY created_at DESC LIMIT ?').bind(missionId,limit).all();
        const events=(rows.results||[]).map(r=>({...r,artifact_hashes:JSON.parse(r.artifact_hashes_json||'[]'),tags:JSON.parse(r.tags_json||'[]'),artifact_hashes_json:undefined,tags_json:undefined}));
        return reply({jsonrpc:'2.0',id,result:toolResult({ok:true,protocol:'VONE_OPERATIONAL_LEARNING_R1',mission_id:missionId,count:events.length,events,weight_training:false})});
      }

      if (name === 'vone_job_status') {
        const jobId=String(args.job_id||'').slice(0,128); if(!jobId)throw new Error('job_id required');
        const row=await env.DB.prepare('SELECT id,status,tool_name,args,created_at,claimed_at,finished_at,worker_id,result,error FROM jobs WHERE id=?').bind(jobId).first();
        if(!row)throw new Error('job_not_found');
        let result=null; try{result=row.result?JSON.parse(row.result):null}catch{}
        let nativeValidation=null;
        if(row.status==='done'&&row.tool_name==='vone_executor_execute'){
          let expected={}; try{expected=JSON.parse(row.args||'{}')}catch{}
          nativeValidation=validateNativeExecutionResult(result,expected);
          if(!nativeValidation.ok){
            return reply({jsonrpc:'2.0',id,result:toolResult({ok:false,terminal:true,job:{id:row.id,status:'error',tool_name:row.tool_name,created_at:row.created_at,claimed_at:row.claimed_at,finished_at:row.finished_at,worker_id:row.worker_id||null,result:null,error:'NATIVE_RESULT_INVALID:'+nativeValidation.code},native_validation:nativeValidation})});
          }
        }
        const terminal=row.status==='done'||row.status==='error';
        const payload={ok:true,job:{id:row.id,status:row.status,tool_name:row.tool_name,created_at:row.created_at,claimed_at:row.claimed_at,finished_at:row.finished_at,worker_id:row.worker_id||null,result,error:row.error||null},terminal,native_validation:nativeValidation};
        if(args.consume===true&&terminal)await env.DB.prepare('DELETE FROM jobs WHERE id=?').bind(jobId).run();
        return reply({jsonrpc:'2.0',id,result:toolResult(payload)});
      }

      if (name === 'vone_delegate_execute') {
        const delegateStartedAt=Date.now();
        const prompt=String(args.prompt||'').slice(0,60000); if(!prompt)throw new Error('prompt required');
        const resolvedProfile=selectCloudProfile(args.profile,prompt);
        const contextCap=resolvedProfile==='FAST'?3000:resolvedProfile==='SMART'?6000:12000;
        const mission=await env.DB.prepare('SELECT mission_id,phase,objective,checkpoint_json,revision,updated_at FROM continuity_missions WHERE mission_id=?').bind('vone-master').first();
        let checkpoint={}; try{checkpoint=JSON.parse(mission?.checkpoint_json||'{}')}catch{}
        const checkpointRevision=Number(mission?.revision||0);
        const taskId=String(args.task_id||('task_'+crypto.randomUUID())).slice(0,160);
        const idempotencyKey=String(args.idempotency_key||('delegate:'+taskId+':r'+checkpointRevision)).slice(0,240);
        const executorSnapshot=await workerSnapshotByCapability(env,'vone_executor_execute');
        const nativeExecutor=executorSnapshot.online;
        const legacyWorkerOnline=snapshot.online;
        const executionMode=(nativeExecutor||legacyWorkerOnline)?'OWNED':'CLOUD';
        const capacitySnapshot=await executionCapacitySnapshot(env,resolvedProfile,executionMode);
        let execution,route,contextChars=0;
        if(!capacitySnapshot.selected){
          execution={status:'BLOCKED',error_class:'NoVerifiedCapacity',evidence:{capacity_snapshot:capacitySnapshot.protocol,outcome:capacitySnapshot.outcome,execution_mode:executionMode}};
          route='HOLD_NO_VERIFIED_CAPACITY';
        } else if(nativeExecutor){
          execution=await queueTool(env,'vone_executor_execute',{
            protocol:'VONE_EXECUTION_CONTRACT_R1',mission_id:mission?.mission_id||'vone-master',task_id:taskId,
            checkpoint_revision:checkpointRevision,objective:prompt,idempotency_key:idempotencyKey,capacity_snapshot:capacitySnapshot
          },{preserveOnTimeout:true,timeoutMs:26000});
          route='OWNED_VONE_EXECUTOR';
        } else {
          const context=JSON.stringify({mission_id:mission?.mission_id||'vone-master',phase:mission?.phase||null,objective:mission?.objective||null,revision:checkpointRevision,checkpoint}).slice(0,contextCap);
          contextChars=context.length;
          const executivePrompt=[
            'You are the V-ONE executive worker. The supervisor model must stay lightweight.',
            'Do the substantial reasoning/execution yourself. Do not ask the supervisor to repeat work.',
            'Preserve PAID_BLOCKED, unknown-cost HOLD, privacy gates and physical-output lock.',
            'Return a concise final result plus evidence/checks that the supervisor can present.',
            'CANONICAL MISSION CONTEXT:\n'+context,
            'CURRENT TASK:\n'+prompt
          ].join('\n\n');
          const execArgs={prompt:executivePrompt,profile:resolvedProfile,max_tokens:Math.max(64,Math.min(Number(args.max_tokens||768),2048))};
          if(snapshot.online){execution=await queueTool(env,'ask_yellow',execArgs);route='OWNED_WORKER_LEGACY_COMPAT';}
          else {execution=await runCloudAi(env,execArgs);route='CLOUDFLARE_ZERO_COST_GATED';}
        }
        const executionStatus=String(execution?.status||execution?.state?.status||'DONE').toUpperCase();
        const terminalOk=executionStatus==='DONE'||executionStatus==='COMPLETED';
        let learning=null;
        if(args.record_learning!==false){
          learning=await recordOperationalLearning(env,{mission_id:'vone-master',kind:'delegated_execution',summary:prompt.slice(0,1200),outcome:(terminalOk?'COMPLETED':'TERMINAL_'+executionStatus)+' via '+route,checkpoint_ref:'revision:'+String(checkpointRevision),tags:['delegate','supervisor-light',route,executionStatus],source:'vone_delegate_execute'});
        }
        return reply({jsonrpc:'2.0',id,result:toolResult({ok:terminalOk,mode:'VONE_EXECUTIVE_DELEGATION_R1',execution_contract:'VONE_EXECUTION_CONTRACT_R1',resolved_profile:resolvedProfile,context_budget_chars:contextCap,context_chars:contextChars,master_elapsed_ms:Date.now()-delegateStartedAt,capacity_snapshot_protocol:capacitySnapshot.protocol,capacity_snapshot_outcome:capacitySnapshot.outcome,capacity_task_class:capacitySnapshot.task?.task_class||null,capacity_selected_route:capacitySnapshot.selected?.route_id||null,supervisor_role:'LIGHTWEIGHT',route,task_id:taskId,idempotency_key:idempotencyKey,checkpoint_revision:checkpointRevision,execution_status:executionStatus,execution,learning_id:learning?.id||null,gates:{paid_blocked:'INVIOLABLE',unknown_cost:'HOLD',physical_output:'LOCKED'}})});
      }

      if (name === 'yellow_status') {
        const cloudRoute = await getCapacityRoute(env, 'cloudflare-workers-ai-primary');
        const cloudEligible = cloudRoute &&
          ['FREE_AVAILABLE','FREE_QUEUE','FREE_QUOTA_LOW'].includes(cloudRoute.state) &&
          cloudRoute.cost?.variable_cost_allowed === false &&
          cloudRoute.cost?.verified_zero_cost === true;
        const localYellow = await workerSnapshotByCapability(env, 'ask_yellow');
        const localStatus = localYellow.worker?.status || {};
        const activeBackend = cloudEligible
          ? 'cloudflare-workers-ai'
          : (localYellow.online ? (localStatus.backend || 'ollama') : 'HOLD');
        return reply({
          jsonrpc: '2.0',
          id,
          result: toolResult({
            status: cloudEligible || localYellow.online ? 'ONLINE' : 'HOLD',
            backend: activeBackend,
            primary: cloudEligible,
            models: cloudEligible ? CLOUD_MODELS : {},
            cloud_route_state: cloudRoute?.state || 'UNKNOWN',
            cloud_verified_zero_cost: cloudRoute?.cost?.verified_zero_cost === true,
            paid_fallback: false,
            fallback_worker_online: localYellow.online,
            fallback_worker: localYellow.online ? localStatus : null,
            control_plane: {
              provider: 'cloudflare-workers',
              transport: 'edge-ai-primary',
              heartbeat_age_seconds: localYellow.ageSeconds,
              canonical: true,
              online: true
            }
          })
        });
      }

      if (name === 'yellow_route_preview') {
        const profile = selectCloudProfile(args.profile, args.prompt);
        const cloudRoute = await getCapacityRoute(env, 'cloudflare-workers-ai-primary');
        const cloudEligible = cloudRoute &&
          ['FREE_AVAILABLE','FREE_QUEUE','FREE_QUOTA_LOW'].includes(cloudRoute.state) &&
          cloudRoute.cost?.variable_cost_allowed === false &&
          cloudRoute.cost?.verified_zero_cost === true;
        if (cloudEligible) {
          return reply({
            jsonrpc: '2.0',
            id,
            result: toolResult({
              route: 'CLOUDFLARE_WORKERS_AI',
              profile,
              model: CLOUD_MODELS[profile],
              fallback: 'NONE',
              cloud_route_state: cloudRoute.state,
              cloud_verified_zero_cost: true,
              paid_fallback: false,
              prompt_chars: String(args.prompt || '').length
            })
          });
        }
        const localYellow = await workerSnapshotByCapability(env, 'ask_yellow');
        const localStatus = localYellow.worker?.status || {};
        if (localYellow.online) {
          return reply({
            jsonrpc: '2.0',
            id,
            result: toolResult({
              route: 'OWNED_YELLOW_FALLBACK',
              profile,
              model: localStatus.model || null,
              fallback: 'NONE',
              cloud_route_state: cloudRoute?.state || 'UNKNOWN',
              cloud_verified_zero_cost: false,
              paid_fallback: false,
              prompt_chars: String(args.prompt || '').length
            })
          });
        }
        return reply({
          jsonrpc: '2.0',
          id,
          result: toolResult({
            route: 'HOLD',
            profile,
            model: null,
            fallback: 'NONE',
            reason: 'NO_VERIFIED_ZERO_COST_CLOUD_OR_FRESH_OWNED_YELLOW',
            cloud_route_state: cloudRoute?.state || 'UNKNOWN',
            cloud_verified_zero_cost: false,
            paid_fallback: false,
            prompt_chars: String(args.prompt || '').length
          })
        });
      }
      if (name === 'ask_yellow') {
        const result = await runYellowWithFallback(env, args);
        return reply({ jsonrpc: '2.0', id, result: toolResult(result) });
      }

      throw new Error('Unsupported tool');
    } catch (e) {
      return reply({ jsonrpc: '2.0', id, error: { code: -32000, message: e?.message || 'Worker error' } });
    }
  }

  return reply({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
}

async function handleWorkerIdentityBootstrap(request, env) {
  if (!(await workerAuthorized(request))) return reply({ error: 'Unauthorized' }, 401);
  const body = await readJson(request);
  const workerId = String(body.workerId || '').trim().slice(0, 120);
  if (!workerId) return reply({ error: 'workerId required' }, 400);

  const row = await env.DB.prepare(
    'SELECT worker_id,status,generation,last_authenticated_at FROM worker_identities_r1 WHERE worker_id=? LIMIT 1'
  ).bind(workerId).first();
  if (!row) return reply({ error: 'worker_identity_not_found' }, 404);
  if (row.status !== 'ACTIVE') return reply({ error: 'worker_identity_revoked' }, 409);
  if (Number(row.last_authenticated_at || 0) > 0) {
    return reply({ error: 'worker_identity_already_activated' }, 409);
  }

  const nextGeneration = Number(row.generation || 0) + 1;
  const token = 'vone_wkr_' + randomToken(48);
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const update = await env.DB.prepare(
    "UPDATE worker_identities_r1 SET token_hash=?,generation=?,rotated_at=?,last_authenticated_at=NULL WHERE worker_id=? AND status='ACTIVE' AND generation=? AND last_authenticated_at IS NULL"
  ).bind(tokenHash, nextGeneration, now, workerId, Number(row.generation || 0)).run();

  if (!update.meta?.changes) return reply({ error: 'bootstrap_conflict' }, 409);
  return reply({
    ok: true,
    protocol: 'VONE_WORKER_IDENTITY_R1',
    workerId,
    token,
    generation: nextGeneration,
    rotated_at: now,
    bootstrap: true
  });
}

async function handleWorkerIdentityRotate(request, env) {
  if (!(await legacyClientAuthorized(request))) return reply({ error: 'Unauthorized' }, 401);
  const body = await readJson(request);
  const workerId = String(body.workerId || '').trim().slice(0, 120);
  if (!workerId) return reply({ error: 'workerId required' }, 400);

  const row = await env.DB.prepare(
    'SELECT worker_id,status,generation FROM worker_identities_r1 WHERE worker_id=? LIMIT 1'
  ).bind(workerId).first();
  if (!row) return reply({ error: 'worker_identity_not_found' }, 404);
  if (row.status !== 'ACTIVE') return reply({ error: 'worker_identity_revoked' }, 409);

  const nextGeneration = Number(row.generation || 0) + 1;
  const token = 'vone_wkr_' + randomToken(48);
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const update = await env.DB.prepare(
    "UPDATE worker_identities_r1 SET token_hash=?,generation=?,rotated_at=?,last_authenticated_at=NULL WHERE worker_id=? AND status='ACTIVE' AND generation=?"
  ).bind(tokenHash, nextGeneration, now, workerId, Number(row.generation || 0)).run();

  if (!update.meta?.changes) return reply({ error: 'rotation_conflict' }, 409);
  return reply({
    ok: true,
    protocol: 'VONE_WORKER_IDENTITY_R1',
    workerId,
    token,
    generation: nextGeneration,
    rotated_at: now
  });
}

async function handleHeartbeat(request, env) {
  const body = await readJson(request);
  const auth = await authorizeWorkerRequest(request, env, body);
  if (!auth.ok) return reply({ error: 'Unauthorized', identity_reason: auth.identity_reason }, 401);
  const workerId = auth.workerId || String(body.workerId || 'LIGHTNING_T4_01').slice(0, 120);
  const version = String(body.version || '1.0.0').slice(0, 80);
  const rawStatus = body.statusPayload && typeof body.statusPayload === 'object' ? body.statusPayload : {};
  const statusPayload = {
    ...rawStatus,
    auth_mode: auth.mode,
    identity_generation: auth.generation,
    identity_reason: auth.mode === 'IDENTITY_R1' ? null : (auth.identity_reason || null)
  };
  const statusJson = JSON.stringify(statusPayload);
  const now = Date.now();

  await env.DB.prepare(`
    INSERT INTO worker_status (worker_id,updated_at,version,status_json)
    VALUES (?,?,?,?)
    ON CONFLICT(worker_id) DO UPDATE SET
      updated_at=excluded.updated_at,
      version=excluded.version,
      status_json=excluded.status_json
  `).bind(workerId, now, version, statusJson).run();

  const workerCapabilities = Array.isArray(rawStatus?.capabilities)
    ? rawStatus.capabilities.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  if (workerCapabilities.includes('vone_executor_execute')) {
    const localRouteRow = await env.DB.prepare(
      "SELECT * FROM capacity_routes WHERE route_id='local-ollama-vone-fallback' LIMIT 1"
    ).first();
    if (localRouteRow) {
      const localRoute = dbRowToRoute(localRouteRow, now);
      const ollamaHealthy = rawStatus?.ollama_health === 'ONLINE';
      localRoute.health.observed_at = ollamaHealthy
        ? new Date(now).toISOString()
        : '1970-01-01T00:00:00.000Z';
      localRoute.state = ollamaHealthy ? deriveCapacityState(localRoute, now) : 'OFFLINE';
      await env.DB.prepare(
        "UPDATE capacity_routes SET state=?,health_json=?,updated_at=?,heartbeat_at=? WHERE route_id='local-ollama-vone-fallback'"
      ).bind(
        localRoute.state,
        JSON.stringify(localRoute.health),
        now,
        now
      ).run();
    }
  }

  const activeJobId=String(rawStatus?.active_job_id||'').slice(0,128);
  let renewedJob=false;
  if(activeJobId){
    const renewed=await env.DB.prepare("UPDATE jobs SET claimed_at=? WHERE id=? AND worker_id=? AND status='claimed'").bind(now,activeJobId,workerId).run();
    renewedJob=Boolean(renewed.meta?.changes);
  }

  return reply({ ok: true, serverTime: now, renewedJob, auth_mode: auth.mode, identity_generation: auth.generation });
}

async function handleClaim(request, env) {
  const body = await readJson(request);
  const auth = await authorizeWorkerRequest(request, env, body);
  if (!auth.ok) return reply({ error: 'Unauthorized', identity_reason: auth.identity_reason }, 401);
  const workerId = auth.workerId || String(body.workerId || 'LIGHTNING_T4_01').slice(0, 120);
  await resetStaleClaims(env);

  const workerRow = await env.DB.prepare(
    "SELECT status_json FROM worker_status WHERE worker_id=? LIMIT 1"
  ).bind(workerId).first();

  let capabilities = auth.mode === 'IDENTITY_R1' && auth.capabilities.length > 0
    ? [...auth.capabilities]
    : [];
  if (capabilities.length === 0) {
    try {
      const status = JSON.parse(workerRow?.status_json || '{}');
      if (Array.isArray(status?.capabilities)) {
        capabilities = [...new Set(
          status.capabilities
            .map((value) => String(value || '').trim())
            .filter(Boolean)
            .slice(0, 64)
        )];
      }
    } catch {}
  }

  let pending = null;
  if (capabilities.length > 0) {
    const placeholders = capabilities.map(() => '?').join(',');
    pending = await env.DB.prepare(
      `SELECT id,tool_name,args FROM jobs
       WHERE status='pending' AND tool_name IN (${placeholders})
       ORDER BY created_at ASC LIMIT 1`
    ).bind(...capabilities).first();
  } else {
    // Backward-compatible fallback for legacy workers that do not advertise
    // capabilities yet. Capability-aware workers are strictly filtered.
    pending = await env.DB.prepare(
      "SELECT id,tool_name,args FROM jobs WHERE status='pending' ORDER BY created_at ASC LIMIT 1"
    ).first();
  }

  if (!pending) return reply({
    ok: true,
    job: null,
    dispatcher: capabilities.length > 0 ? 'CAPABILITY_AWARE_R1' : 'LEGACY_FALLBACK',
    capabilities
  });

  const claimedAt = Date.now();
  const update = await env.DB.prepare(
    "UPDATE jobs SET status='claimed',claimed_at=?,worker_id=? WHERE id=? AND status='pending'"
  ).bind(claimedAt, workerId, pending.id).run();

  if (!update.meta?.changes) return reply({ ok: true, job: null });

  let args = {};
  try { args = JSON.parse(pending.args || '{}'); } catch {}
  return reply({
    ok: true,
    job: {
      id: pending.id,
      toolName: pending.tool_name,
      arguments: args
    }
  });
}

async function handleResult(request, env) {
  const body = await readJson(request);
  const auth = await authorizeWorkerRequest(request, env, body);
  if (!auth.ok) return reply({ error: 'Unauthorized', identity_reason: auth.identity_reason }, 401);
  const jobId = String(body.jobId || '').slice(0,128);
  const workerId = auth.workerId || String(body.workerId || '').slice(0,120);
  if (!jobId) return reply({ error: 'jobId required' }, 400);

  const job = await env.DB.prepare('SELECT status,worker_id,tool_name,args FROM jobs WHERE id=?').bind(jobId).first();
  if (!job) return reply({ error: 'Job not found' }, 404);
  if (job.status !== 'claimed') return reply({ error:'Job is not actively claimed', status:job.status, worker_id:job.worker_id||null },409);
  if (workerId && String(job.worker_id||'') !== workerId) {
    return reply({ error:'Job is not actively claimed by this worker', status:job.status, worker_id:job.worker_id||null },409);
  }

  let status = body.error ? 'error' : 'done';
  let resultJson = body.error ? null : JSON.stringify(body.result ?? {});
  let errText = body.error ? String(body.error).slice(0, 4000) : null;
  let nativeValidation = null;

  if (!body.error && job.tool_name === 'vone_executor_execute') {
    let expected = {};
    try { expected = JSON.parse(job.args || '{}'); } catch {}
    nativeValidation = validateNativeExecutionResult(body.result, expected);
    if (!nativeValidation.ok) {
      status = 'error';
      resultJson = null;
      errText = ('NATIVE_RESULT_INVALID:' + nativeValidation.code).slice(0,4000);
    }
  }

  const finishedAt = Date.now();
  const update = workerId
    ? await env.DB.prepare("UPDATE jobs SET status=?,finished_at=?,result=?,error=? WHERE id=? AND worker_id=? AND status='claimed'").bind(status,finishedAt,resultJson,errText,jobId,workerId).run()
    : await env.DB.prepare("UPDATE jobs SET status=?,finished_at=?,result=?,error=? WHERE id=? AND status='claimed'").bind(status,finishedAt,resultJson,errText,jobId).run();

  if (!update.meta?.changes) {
    const row=await env.DB.prepare('SELECT status,worker_id FROM jobs WHERE id=?').bind(jobId).first();
    if(!row)return reply({ error: 'Job not found' }, 404);
    return reply({ error: 'Job is not actively claimed by this worker', status: row.status, worker_id: row.worker_id || null }, 409);
  }
  return reply({ ok: status === 'done', native_validation: nativeValidation, error: errText });
}

async function handleContinuityCheckpoint(request, env) {
  if (!(await clientAuthorized(request))) return reply({error:'Unauthorized'},401);
  const body = await readJson(request);
  const missionId = String(body.mission_id || '').trim().slice(0,128);
  if (!missionId) return reply({error:'mission_id required'},400);
  const now = Date.now();
  const title = String(body.title || missionId).slice(0,200);
  const status = String(body.status || 'ACTIVE').slice(0,40);
  const phase = String(body.phase || '').slice(0,120);
  const objective = String(body.objective || '').slice(0,4000);
  const source = String(body.source || 'v-one').slice(0,80);
  const checkpoint = JSON.stringify(body.checkpoint || {});
  if (checkpoint.length > 120000) return reply({error:'checkpoint too large'},413);
  const current = await env.DB.prepare('SELECT revision FROM continuity_missions WHERE mission_id=?').bind(missionId).first();
  const revision = Number(current?.revision || 0) + 1;
  await env.DB.prepare(`
    INSERT INTO continuity_missions(mission_id,title,status,phase,objective,checkpoint_json,source,revision,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(mission_id) DO UPDATE SET title=excluded.title,status=excluded.status,phase=excluded.phase,objective=excluded.objective,checkpoint_json=excluded.checkpoint_json,source=excluded.source,revision=excluded.revision,updated_at=excluded.updated_at
  `).bind(missionId,title,status,phase,objective,checkpoint,source,revision,now,now).run();
  await env.DB.prepare('INSERT INTO continuity_events(mission_id,event_type,payload_json,created_at) VALUES(?,?,?,?)')
    .bind(missionId,'CHECKPOINT',JSON.stringify({revision,phase,status,source}),now).run();
  return reply({ok:true,mission_id:missionId,revision,updated_at:now});
}

async function handleContinuityArtifact(request, env) {
  if (!(await clientAuthorized(request))) return reply({error:'Unauthorized'},401);
  const body=await readJson(request);
  const missionId=String(body.mission_id||'').slice(0,128), artifactId=String(body.artifact_id||'').slice(0,180);
  if(!missionId||!artifactId) return reply({error:'mission_id and artifact_id required'},400);
  const now=Date.now(), metadata=JSON.stringify(body.metadata||{});
  await env.DB.prepare(`
    INSERT INTO continuity_artifacts(mission_id,artifact_id,name,kind,location,sha256,size_bytes,metadata_json,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(mission_id,artifact_id) DO UPDATE SET name=excluded.name,kind=excluded.kind,location=excluded.location,sha256=excluded.sha256,size_bytes=excluded.size_bytes,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at
  `).bind(missionId,artifactId,String(body.name||artifactId).slice(0,240),String(body.kind||'file').slice(0,40),String(body.location||'').slice(0,1000),body.sha256?String(body.sha256).slice(0,80):null,Number.isFinite(Number(body.size_bytes))?Number(body.size_bytes):null,metadata,now).run();
  await env.DB.prepare('INSERT INTO continuity_events(mission_id,event_type,payload_json,created_at) VALUES(?,?,?,?)').bind(missionId,'ARTIFACT',JSON.stringify({artifact_id:artifactId,kind:body.kind||'file'}),now).run();
  return reply({ok:true,mission_id:missionId,artifact_id:artifactId,updated_at:now});
}

async function handleContinuityResume(request, env) {
  if (!(await clientAuthorized(request))) return reply({error:'Unauthorized'},401);
  const url = new URL(request.url);
  const missionId = String(url.searchParams.get('mission_id') || '').slice(0,128);
  if (!missionId) return reply({error:'mission_id required'},400);
  const row = await env.DB.prepare('SELECT * FROM continuity_missions WHERE mission_id=?').bind(missionId).first();
  if (!row) return reply({error:'mission_not_found'},404);
  let checkpoint={}; try { checkpoint=JSON.parse(row.checkpoint_json||'{}'); } catch {}
  const events = await env.DB.prepare('SELECT event_type,payload_json,created_at FROM continuity_events WHERE mission_id=? ORDER BY created_at DESC LIMIT 20').bind(missionId).all();
  return reply({ok:true,mission:{mission_id:row.mission_id,title:row.title,status:row.status,phase:row.phase,objective:row.objective,source:row.source,revision:row.revision,updated_at:row.updated_at,checkpoint},events:events.results||[]});
}

async function handleContinuityResumePacket(request, env) {
  if (!(await clientAuthorized(request))) return reply({error:'Unauthorized'},401);
  const url=new URL(request.url), missionId=String(url.searchParams.get('mission_id')||'').slice(0,128);
  if(!missionId) return reply({error:'mission_id required'},400);
  const row=await env.DB.prepare('SELECT * FROM continuity_missions WHERE mission_id=?').bind(missionId).first();
  if(!row) return reply({error:'mission_not_found'},404);
  let checkpoint={}; try{checkpoint=JSON.parse(row.checkpoint_json||'{}')}catch{}
  const artifacts=await env.DB.prepare('SELECT artifact_id,name,kind,location,sha256,size_bytes,metadata_json,updated_at FROM continuity_artifacts WHERE mission_id=? ORDER BY updated_at DESC LIMIT 100').bind(missionId).all();
  const events=await env.DB.prepare('SELECT event_type,payload_json,created_at FROM continuity_events WHERE mission_id=? ORDER BY created_at DESC LIMIT 30').bind(missionId).all();
  const packet={
    protocol:'VONE_CONTINUITY_R2', instruction:'Continue exactly from this checkpoint. Do not restart completed work.',
    mission:{mission_id:row.mission_id,title:row.title,status:row.status,phase:row.phase,objective:row.objective,revision:row.revision,updated_at:row.updated_at},
    checkpoint, artifacts:artifacts.results||[], recent_events:events.results||[],
    gates:{paid_blocked:'INVIOLABLE',unknown_cost:'HOLD',physical_output:'LOCKED'}
  };
  return reply({ok:true,resume_packet:packet});
}

async function handleContinuityList(request, env) {
  if (!(await clientAuthorized(request))) return reply({error:'Unauthorized'},401);
  const rows = await env.DB.prepare('SELECT mission_id,title,status,phase,source,revision,updated_at FROM continuity_missions ORDER BY updated_at DESC LIMIT 50').all();
  return reply({ok:true,missions:rows.results||[]});
}

async function handleStatus(env) {
  const cloud = await ensureCloudAiRoute(env);
  return reply({
    ok: true,
    service: 'V-ONE Control Plane',
    version: '2.4.7-worker-identity-r1-compat',
    canonical: true,
    provider: 'cloudflare-workers',
    architecture: 'MASTER_CONTROL__OWNED_EXECUTOR_PRE_E2E',
    cloudAiBound: Boolean(env.AI),
    cloudAiExecution: cloud.route.state,
    cloudBudget: cloud.budget,
    primaryModels: CLOUD_MODELS,
    desktopRole: 'DEV_ONLY',
    localInference: false,
    localFallback: false,
    publicGpuPorts: false,
    authenticatedMcp: true,
    oauth: 'DIRECT_CLOUDFLARE_PASS',
    supervisorMode: 'LIGHTWEIGHT',
    executionContract: 'VONE_EXECUTION_CONTRACT_R1',
    capacitySnapshot: 'VONE_CAPACITY_SNAPSHOT_R1',
    ownedExecutor: 'PRE_E2E_ASYNC_CONTROL_READY',
    executionPolicy: VONE_EXECUTION_POLICY,
    controlPlaneAvailability: 'DECOUPLED_FROM_AI_CAPACITY',
    asyncJobStatusTool: 'vone_job_status',
    nativeClaimRenewal: true,
    nativeResultOwnership: 'WORKER_ID_SUPPORTED',
    freeCapacityBroker: 'P5',
    clientWorkers: true,
    clientExecutionAdapter: true,
    quotaWatcher: true,
    mesh: true,
    parallelVerification: true,
    conflictBehavior: 'HOLD',
    mobilePwa: { enabled: true, path: '/vone-mobile', pairing: 'DEVICE_HASH_APPROVAL_R1' }
  });
}

async function handleMobileStatus(env) {
  const mission = await env.DB.prepare(
    'SELECT mission_id,title,status,phase,revision,updated_at FROM continuity_missions WHERE mission_id=?'
  ).bind('vone-master').first();
  const routes = await listCapacityRoutes(env);
  const states = { FREE_AVAILABLE:0, FREE_QUEUE:0, FREE_QUOTA_LOW:0, FREE_EXHAUSTED:0, PAID_BLOCKED:0, OFFLINE:0 };
  for (const route of routes) if (Object.hasOwn(states, route.state)) states[route.state]++;
  return reply({
    ok: true,
    service: 'V-ONE Mobile',
    version: '1.0.0-pwa-r1',
    mission: mission || null,
    capacity: { routes: routes.length, states },
    gates: { paid_blocked:'INVIOLABLE', unknown_cost:'HOLD', physical_output:'LOCKED' }
  });
}

async function ensureMobileHistorySchema(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS mobile_chat_messages (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_mobile_chat_device_time ON mobile_chat_messages(device_id,created_at)`).run();
}
async function handleMobileTool(request, env) {
  const device = await mobileAuthorized(request,env);
  if (!device) return reply({ok:false,error:'mobile_auth_required'},401);
  const body = await readJson(request);
  const name = String(body.name||'');
  if (name === 'vone_status') {
    const budget = await cloudBudgetSnapshot(env);
    const route = await getCapacityRoute(env,'cloudflare-workers-ai-primary');
    return reply({ok:true,tool:name,master:'ONLINE',route:route?.state||'UNKNOWN',local_budget:budget});
  }
  if (name === 'vone_capacity_plan') {
    const plan = await evaluateCapacityHA(env);
    return reply({ok:true,tool:name,capacity:plan});
  }
  if (name === 'vone_tool_catalog') {
    const user=await approvedUserIdentity(request,env);
    if (!user) return reply({ok:false,error:'approved_account_required'},403);
    const definitions=toolDefinitions();
    const worker=await workerSnapshotByCapability(env,'vone_executor_execute');
    const caps=worker.worker?.status?.capabilities||[];
    const contracts=worker.worker?.status?.execution_contracts||[];
    const codeReady=worker.online&&caps.includes('CODE_REVIEW')&&contracts.includes('VONE_EXECUTION_CONTRACT_R1');
    const codeAllowed=await userHasPermission(request,env,'CODE_REVIEW');
    const tools=await Promise.all(definitions.map(async d=>{
      const readOnly=Boolean(d.annotations?.readOnlyHint);
      const permission=readOnly?'TOOLS_READ':'AGENT_DISPATCH';
      const allowed=await userHasPermission(request,env,permission);
      return {name:d.name,description:d.description,mode:readOnly?'READ_ONLY':'MUTATING',state:allowed?(readOnly?'MCP_ONLY':'MCP_ONLY_VERIFICATION_REQUIRED'):'PERMISSION_DENIED',permission};
    }));
    tools.push({name:'vone_executor_execute',description:'Owned Executor native CODE_REVIEW via mobile chat execution mode',mode:'EXECUTION',state:!codeAllowed?'PERMISSION_DENIED':codeReady?'EXECUTOR_VERIFIED':'HOLD_NO_VERIFIED_EXECUTOR',permission:'CODE_REVIEW',evidence:{worker_online:worker.online,worker_id:worker.worker?.workerId||null,heartbeat_age_seconds:worker.ageSeconds,capabilities:caps,contracts}});
    const hub=await workerSnapshotByCapability(env,'vone_hub_chat');
    const hubReady=hub.online&&(hub.worker?.status?.execution_contracts||[]).includes('VONE_HUB_CHAT_R1')&&hub.worker?.status?.ollama_health==='ONLINE';
    tools.push({name:'vone_hub_chat',description:'V-ONE Unified Hub Agent + ModelRouter, local verified chat',mode:'INFERENCE',state:hubReady?'EXECUTOR_VERIFIED':'HOLD_NO_VERIFIED_HUB',permission:'TOOLS_READ',evidence:{worker_online:hub.online,worker_id:hub.worker?.workerId||null,heartbeat_age_seconds:hub.ageSeconds,model:hub.worker?.status?.model||null}});
    return reply({ok:true,tool:name,scope:'mobile-workspace',execution_policy:'verified-only',cost_policy:{paid:'BLOCKED',unknown:'HOLD'},tools});
  }
  return reply({ok:false,error:'tool_not_allowed'},403);
}
async function handleMobileHistory(request, env) {
  const device = await mobileAuthorized(request, env);
  if (!device) return reply({ok:false,error:'mobile_auth_required'},401);
  await ensureMobileHistorySchema(env);
  const rows = await env.DB.prepare('SELECT id,role,content,created_at FROM mobile_chat_messages WHERE device_id=? ORDER BY created_at DESC LIMIT 100').bind(device.device_id).all();
  return reply({ok:true,scope:'device',messages:(rows.results||[]).reverse()});
}
async function saveMobileMessage(env,deviceId,role,content) {
  await ensureMobileHistorySchema(env);
  await env.DB.prepare('INSERT INTO mobile_chat_messages(id,device_id,role,content,created_at) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),deviceId,role,String(content).slice(0,24000),Date.now()).run();
}
function classifyAgentIntent(prompt, body = {}) {
  if (body.execution_mode === 'OWNED_CODE_REVIEW') return 'CODE_REVIEW';
  if (body.execution_mode === 'CHAT_ONLY') return 'CHAT';
  const raw=String(prompt||'').toLowerCase();
  if (/(e2e|end.to.end|ponta.a.ponta)/i.test(raw)&&/(execut|valid|test|rod|inici|prossig|certific)/i.test(raw)) return 'E2E_EXECUTION';

  const text=String(prompt||'').toLowerCase();
  const action=['implementar','implemente','corrigir','corrija','editar','edite','alterar','altere','executar','execute','rodar','rode','construir','construa','deploy','publicar','publique','commit','patch','refatorar','refatore'].some(w=>text.includes(w));
  const code=['código','codigo','arquivo','repositório','repositorio','branch','commit','script','função','funcao','teste','typescript','javascript','python','github','executor','backend','frontend','api','plugin'].some(w=>text.includes(w));
  const review=/\b(code.review|revis[aã]o de c[oó]digo|revisar|revise|inspecionar|inspecione|auditar|audite)\b/i.test(text);
  const readOnly=/\b(somente leitura|sem modificar|sem alterar|read.only|nenhuma altera[cç][aã]o)\b/i.test(text);
  const mutating=/\b(implementar|implemente|corrigir|corrija|editar|edite|alterar|altere|modificar|modifique|deploy|publicar|publique|commit|patch|refatorar|refatore)\b/i.test(text);
  // Review-only intent takes precedence over incidental mutation words in a negated instruction.
  // Authorization, capacity, and evidence gates remain enforced by the CODE_REVIEW branch.
  if(review&&readOnly) return 'CODE_REVIEW';
  return action&&code?'ENGINEERING_ACTION':'CHAT';
}
async function handleMobileChat(request, env) {
  const device = await mobileAuthorized(request, env);
  if (!device) return reply({ ok:false, error:'mobile_auth_required' }, 401);
  const body = await readJson(request);
  const prompt = String(body.prompt || '').trim().slice(0, 24000);
  if (!prompt) return reply({ ok:false, error:'prompt_required' }, 400);
  const profile = ['AUTO','FAST','SMART','MAX'].includes(String(body.profile || 'AUTO').toUpperCase())
    ? String(body.profile || 'AUTO').toUpperCase() : 'AUTO';
  const maxTokens = Math.max(64, Math.min(Number(body.max_tokens || 900), 1400));
  await saveMobileMessage(env,device.device_id,'user',prompt);
  const agentIntent=classifyAgentIntent(prompt,body);
  if (agentIntent === 'E2E_EXECUTION') {
    const user=await approvedUserIdentity(request,env);
    if (!user || !(await userHasPermission(request,env,'CODE_EXECUTE'))) return reply({ok:false,status:'HOLD',error:'code_execution_permission_required'},403);
    const worker=await workerSnapshotByCapability(env,'vone_executor_execute');
    const caps=worker.worker?.status?.capabilities||[];
    const contracts=worker.worker?.status?.execution_contracts||[];
    const verified=worker.online&&caps.includes('CODE_REVIEW')&&contracts.includes('VONE_EXECUTION_CONTRACT_R1');
    const evidence={worker_online:worker.online,worker_id:worker.worker?.workerId||null,heartbeat_age_seconds:worker.ageSeconds,capabilities:caps,contracts,required_contract:'VONE_EXECUTION_CONTRACT_R1'};
    const result={ok:false,status:'HOLD',intent:agentIntent,error:verified?'E2E_SUITE_NOT_REGISTERED':'NO_VERIFIED_E2E_EXECUTOR',evidence,text:'E2E not executed or certified. '+(verified?'Authenticated E2E suite not registered.':'Verified executor unavailable.')};
    await saveMobileMessage(env,device.device_id,'assistant',result.text+' '+JSON.stringify(evidence));
    return reply(result,409);
  }
  if (agentIntent === 'ENGINEERING_ACTION') {
    const executor=await workerSnapshotByCapability(env,'vone_executor_execute');
    return reply({ok:false,status:'HOLD',intent:agentIntent,error:'ENGINEERING_ACTION_REQUIRES_VERIFIED_TOOL_DISPATCH',text:'Esta tarefa exige execucao real. O agente nao vai afirmar que editou, testou ou publicou sem ferramenta e evidencia. Use o modo CODE_REVIEW quando a tarefa for uma revisao de codigo; as demais ferramentas de escrita ainda precisam de contratos verificados.',tool_catalog:[{name:'vone_executor_execute',available:executor.online,scope:'CODE_REVIEW'}],evidence:{executor_online:executor.online}},409);
  }
  if (agentIntent === 'CODE_REVIEW') {
    const user = await approvedUserIdentity(request,env);
    if (!user || !(await userHasPermission(request,env,'CODE_REVIEW'))) return reply({ok:false,error:'code_review_permission_required'},403);
    const executor = await workerSnapshotByCapability(env,'vone_executor_execute');
    const capabilities = executor.worker?.status?.capabilities || [];
    const contracts = executor.worker?.status?.execution_contracts || [];
    if (!executor.online || !capabilities.includes('CODE_REVIEW') || !contracts.includes('VONE_EXECUTION_CONTRACT_R1')) return reply({ok:false,status:'HOLD',error:'NoVerifiedCodeReviewExecutor',evidence:{executor_online:executor.online,capabilities,contracts}},409);
    const capacity = await executionCapacitySnapshot(env,selectCloudProfile(profile,prompt),'OWNED');
    if (!capacity.selected) return reply({ok:false,status:'HOLD',error:'NoVerifiedCapacity',evidence:{outcome:capacity.outcome}},409);
    const mission = await env.DB.prepare('SELECT revision FROM continuity_missions WHERE mission_id=?').bind('vone-master').first();
    const taskId='mobile_code_review_'+crypto.randomUUID();
    const args={protocol:'VONE_EXECUTION_CONTRACT_R1',mission_id:'vone-master',task_id:taskId,checkpoint_revision:Number(mission?.revision||0),objective:prompt,idempotency_key:'mobile:'+taskId,capacity_snapshot:capacity};
    try {
      const execution=await queueTool(env,'vone_executor_execute',args,{preserveOnTimeout:true,timeoutMs:26000});
      const status=String(execution?.status||'INCOMPLETE').toUpperCase();
      const validation=status==='DONE'?validateNativeExecutionResult(execution,args):null;
      const passed=Boolean(validation?.ok && status==='DONE');
      const message=passed?'Execucao verificada pelo Owned Executor.':status==='INCOMPLETE'?'Tarefa enviada ao executor; aguardando resultado verificavel.':'Execucao nao certificada; verificar evidencias.';
      const audit={task_id:taskId,job_id:execution?.job_id||null,status:passed?'PASS':status,worker_id:execution?.worker_id||execution?.evidence?.worker_id||null,run_id:execution?.run_id||null,route_id:execution?.route_id||null,model:execution?.model||null,checkpoint_revision:args.checkpoint_revision,local_checkpoint_revision:execution?.evidence?.local_checkpoint_revision??null,validation:validation||null,evidence:execution?.evidence||null,recorded_at:Date.now()};
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS mobile_execution_audit (task_id TEXT PRIMARY KEY,device_id TEXT NOT NULL,created_at INTEGER NOT NULL,audit_json TEXT NOT NULL)').run();
      await env.DB.prepare('INSERT INTO mobile_execution_audit(task_id,device_id,created_at,audit_json) VALUES(?,?,?,?)').bind(taskId,device.device_id,audit.recorded_at,JSON.stringify(audit)).run();
      const receipt=message+'\\n'+JSON.stringify(audit,null,2);
      await saveMobileMessage(env,device.device_id,'assistant',receipt);
      return reply({ok:passed,status:audit.status,execution,validation,task_id:taskId,audit,text:receipt},passed?200:202);
    } catch(error) {return reply({ok:false,status:'HOLD',error:String(error?.message||error).slice(0,300)},503);}
  }
  const hubWorker=await workerSnapshotByCapability(env,'vone_hub_chat');
  if(hubWorker.online && (hubWorker.worker?.status?.execution_contracts||[]).includes('VONE_HUB_CHAT_R1') && hubWorker.worker?.status?.ollama_health==='ONLINE'){
    const taskId='hub_'+crypto.randomUUID();
    try {
      const result=await queueTool(env,'vone_hub_chat',{protocol:'VONE_HUB_CHAT_R1',task_id:taskId,prompt,max_tokens:maxTokens},{preserveOnTimeout:true,timeoutMs:26000});
      if(result?.protocol==='VONE_HUB_CHAT_R1' && result.status==='DONE' && result.task_id===taskId && typeof result.text==='string' && result.text.trim()){
        await saveMobileMessage(env,device.device_id,'assistant',result.text);
        return reply({ok:true,text:result.text,backend:'vone-unified-hub-agent',route:'VONE_OWNED_HUB',model:result.model||null,worker_id:result.worker_id||null,task_id:taskId,execution_verified:true});
      }
      return reply({ok:false,status:'HOLD',error:'VONE_HUB_EXECUTION_PENDING',task_id:taskId,job_id:result?.job_id||null,evidence:result?.evidence||null,text:'V-ONE Hub em execucao; resultado ainda nao verificado.'},202);
    }catch(error){return reply({ok:false,status:'HOLD',error:'VONE_HUB_DISPATCH_FAILED',detail:String(error?.message||error).slice(0,200)},503);}
  }
  return reply({ok:false,status:'HOLD',error:'VONE_HUB_NOT_VERIFIED',evidence:{worker_online:hubWorker.online,contracts:hubWorker.worker?.status?.execution_contracts||[],ollama_health:hubWorker.worker?.status?.ollama_health||null},text:'V-ONE Unified Hub indisponivel; nenhuma resposta direta do GLM foi utilizada.'},503);
  const mission = await env.DB.prepare(
    'SELECT mission_id,status,phase,objective,revision FROM continuity_missions WHERE mission_id=?'
  ).bind('vone-master').first();
  const executivePrompt = [
    'You are V-ONE Master Mobile, the mobile cockpit of the canonical V-ONE orchestrator.',
    'Preserve the current mission state. Do not restart completed work.',
    'Respect PAID_BLOCKED, unknown-cost HOLD, privacy gates and physical-output lock.',
    'Answer in Portuguese unless the user asks otherwise. Be concise, operational and evidence-aware.',
    'CANONICAL MISSION: ' + JSON.stringify(mission || { mission_id:'vone-master', status:'ACTIVE' }),
    'USER REQUEST: ' + prompt
  ].join('\n\n');
  try {
    const result = await runYellowWithFallback(env, { prompt: executivePrompt, profile, max_tokens: maxTokens });
    await saveMobileMessage(env,device.device_id,'assistant',String(result.text || result.response || ''));
    return reply({
      ok: true,
      text: String(result.text || result.response || ''),
      profile: result.profile || profile,
      model: result.model || null,
      backend: result.backend || (result.route === 'OWNED_YELLOW_FALLBACK' ? 'owned-yellow' : 'cloudflare-workers-ai'),
      elapsed_ms: result.elapsed_ms || null,
      route: 'VONE_MOBILE_' + String(result.route || 'YELLOW'),
      cloud_gate: result.cloud_gate || null,
      device: device.device_id
    });
  } catch (error) {
    return reply({ ok:false, error:String(error?.message || error).slice(0,500) }, 503);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === 'GET' && url.pathname === '/vone-access') return accessPage();
    if (url.pathname.startsWith('/api/accounts/')) return userApi(request,env,legacyClientAuthorized);
    if (method === 'GET' && url.pathname === '/vone-admin') return mobileAdminPage();
    if (method === 'GET' && (url.pathname === '/vone-mobile' || url.pathname === '/vone-mobile/')) return mobilePage();
    if (method === 'GET' && url.pathname === '/vone-mobile/manifest.webmanifest') return mobileManifest();
    if (method === 'GET' && url.pathname === '/vone-mobile/icon.svg') return mobileIcon();
    if (method === 'GET' && url.pathname === '/vone-mobile/sw.js') return mobileServiceWorker();

    if (method === 'GET' && url.pathname === '/api/mobile/status') return handleMobileStatus(env);
    if (method === 'POST' && url.pathname === '/api/mobile/enroll/start') {
      const user = await approvedUserIdentity(request,env);
      if (await accountsEnforced(env) && !user) return reply({error:'approved_account_login_required',login_url:'/vone-access'},403);
      return startMobileEnrollment(request,env,user?.id||null);
    }
    if (method === 'GET' && url.pathname === '/api/mobile/execution/audit') {
      const device=await mobileAuthorized(request,env);
      if(!device) return reply({ok:false,error:'mobile_auth_required'},401);
      const taskId=String(url.searchParams.get('task_id')||'').slice(0,128);
      if(!taskId) return reply({ok:false,error:'task_id_required'},400);
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS mobile_execution_audit (task_id TEXT PRIMARY KEY,device_id TEXT NOT NULL,created_at INTEGER NOT NULL,audit_json TEXT NOT NULL)').run();
      const record=await env.DB.prepare('SELECT audit_json FROM mobile_execution_audit WHERE task_id=? AND device_id=?').bind(taskId,device.device_id).first();
      return record?reply({ok:true,audit:JSON.parse(record.audit_json)}):reply({ok:false,error:'audit_not_found'},404);
    }
    if (method === 'GET' && url.pathname === '/api/mobile/enroll/status') return mobileEnrollmentStatus(request, env);
    if (method === 'GET' && url.pathname === '/api/mobile/me') return mobileWhoAmI(request, env);
    if (method === 'POST' && url.pathname === '/api/mobile/disconnect') return mobileDisconnect(request, env);
    if (method === 'POST' && url.pathname === '/api/mobile/chat') return handleMobileChat(request, env);
    if (method === 'GET' && url.pathname === '/api/mobile/history') return handleMobileHistory(request, env);
    if (method === 'POST' && url.pathname === '/api/mobile/tool') return handleMobileTool(request, env);
    if (method === 'GET' && url.pathname === '/api/mobile/admin/devices') {
      if (!(await ownerSession(request,env)) && !(await legacyClientAuthorized(request))) return reply({ error:'admin_login_required' }, 401);
      await ensureMobileSchema(env);
      const rows=await env.DB.prepare("SELECT d.device_id,d.label,d.status,d.created_at,d.approved_at,d.access_expires_at,d.last_seen_at,d.revoked_at,d.user_id,u.name AS user_name,u.email AS user_email FROM mobile_devices d LEFT JOIN vone_users u ON u.id=d.user_id ORDER BY d.created_at DESC LIMIT 100").all();
      return reply({ok:true,devices:rows.results||[]});
    }
    if (method === 'POST' && url.pathname === '/api/mobile/admin/revoke') {
      if (request.headers.get('origin') !== url.origin) return reply({error:'invalid_origin'},403);
      if (!(await ownerSession(request,env)) && !(await legacyClientAuthorized(request))) return reply({ error:'admin_login_required' }, 401);
      await ensureMobileSchema(env);
      const body=await request.json().catch(()=>({}));
      const deviceId=String(body.device_id||'');
      if (!/^[a-zA-Z0-9._:-]{8,96}$/.test(deviceId)) return reply({ok:false,error:'invalid_device_id'},400);
      const result=await env.DB.prepare("UPDATE mobile_devices SET status='REVOKED',revoked_at=?,pairing_code=NULL WHERE device_id=? AND status='APPROVED'").bind(Date.now(),deviceId).run();
      return reply({ok:!!result.meta?.changes,status:result.meta?.changes?'REVOKED':'NOT_FOUND'});
    }
    if (method === 'GET' && url.pathname === '/api/mobile/admin/pending') {
      if (!(await ownerSession(request,env)) && !(await legacyClientAuthorized(request))) return reply({ error:'admin_login_required' }, 401);
      return mobilePendingEnrollments(env);
    }
    if (method === 'POST' && url.pathname === '/api/mobile/admin/approve') {
      if (request.headers.get('origin') !== url.origin) return reply({error:'invalid_origin'},403);
      if (!(await ownerSession(request,env)) && !(await legacyClientAuthorized(request))) return reply({ error:'admin_login_required' }, 401);
      return approveMobileEnrollment(request, env);
    }

    if (method === 'GET' && (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp')) {
      return reply({
        resource: MCP_RESOURCE,
        authorization_servers: [OAUTH_ISSUER],
        scopes_supported: [OAUTH_SCOPE],
        bearer_methods_supported: ['header']
      });
    }

    if (method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource/mcp-secure') {
      return reply({
        resource: MCP_SECURE_RESOURCE,
        authorization_servers: [OAUTH_ISSUER],
        scopes_supported: [OAUTH_SCOPE],
        bearer_methods_supported: ['header']
      });
    }

    if (method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      return reply({
        issuer: OAUTH_ISSUER,
        authorization_endpoint: OAUTH_ISSUER + '/oauth/authorize',
        token_endpoint: OAUTH_ISSUER + '/oauth/token',
        registration_endpoint: OAUTH_ISSUER + '/oauth/register',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code','refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: [OAUTH_SCOPE]
      });
    }

    if (method === 'POST' && url.pathname === '/oauth/register') return handleOAuthRegister(request,env);
    if (method === 'GET' && url.pathname === '/oauth/authorize') return handleOAuthAuthorizeGet(request,env);
    if (method === 'POST' && url.pathname === '/oauth/authorize') return handleOAuthAuthorizePost(request,env);
    if (method === 'POST' && url.pathname === '/oauth/token') return handleOAuthToken(request,env);
    if (method === 'GET' && url.pathname === '/oauth/client-info') return reply({issuer:OAUTH_ISSUER,pkce:'S256',refresh_tokens:true,approval_gate:'VONE_PAIR_CODE',legacy_bearer_preserved:true});

    if (method === 'GET' && url.pathname === '/api/_healthcheck') {
      return reply({ ok: true, service: 'V-ONE Control Plane', version: '2.4.7-worker-identity-r1-compat', continuity: 'R4', mcpNative: 'R1', architecture: 'MASTER_CONTROL__OWNED_EXECUTOR_PRE_E2E', cloudAiBound: Boolean(env.AI), freeCapacityBroker: 'P5', ha: 'R2', cloudSupervisor: true, providerCandidates: true, directCloudAiGate: 'ZERO_COST_APP_HARD_CAP', dailyNeuronHardCap: CLOUD_NEURON_DAILY_HARD_CAP, desktopRole: 'DEV_ONLY', localInference: false, leaseDispatch: true, clientWorkers: true, quotaWatcher: true, mesh: true, parallelVerification: true, conflictBehavior: 'HOLD', providerExecution: true });
    }

    if (method === 'GET' && url.pathname === '/api/app-info') {
      return reply({ok:true,name:'V-ONE Master',version:'2.4.7-worker-identity-r1-compat',continuity:'R4',architecture:'CLAUDE_CHATGPT_LIGHT_SUPERVISOR__VONE_EXECUTIVE',mcp:{endpoint:'/mcp',transport:'streamable-http-jsonrpc',auth:'oauth2+legacy-bearer',oauth_issuer:OAUTH_ISSUER,resource:MCP_RESOURCE,tools:toolDefinitions().map(t=>({name:t.name,description:t.description,annotations:t.annotations||{},securitySchemes:t.securitySchemes||[]}))},gates:{paid_blocked:'INVIOLABLE',unknown_cost:'HOLD',physical_output:'LOCKED'}});
    }

    if (method === 'GET' && url.pathname === '/api/status') {
      return handleStatus(env);
    }

    if (method === 'POST' && url.pathname === '/api/continuity/checkpoint') {
      return handleContinuityCheckpoint(request, env);
    }

    if (method === 'GET' && url.pathname === '/api/continuity/resume') {
      return handleContinuityResume(request, env);
    }

    if (method === 'GET' && url.pathname === '/api/continuity/missions') {
      return handleContinuityList(request, env);
    }

    if (method === 'POST' && url.pathname === '/api/continuity/artifact') {
      return handleContinuityArtifact(request, env);
    }

    if (method === 'GET' && url.pathname === '/api/continuity/resume-packet') {
      return handleContinuityResumePacket(request, env);
    }

    if (method === 'GET' && url.pathname === '/api/capacity/summary') {
      return handleCapacitySummary(env);
    }

    if (method === 'GET' && url.pathname === '/api/capacity/ha') {
      return handleCapacityHA(env);
    }

    if (method === 'GET' && url.pathname === '/api/capacity/routes') {
      return handleCapacityRoutes(request, env);
    }

    if (method === 'POST' && url.pathname === '/api/capacity/register') {
      return handleCapacityRegister(request, env);
    }

    if (method === 'POST' && url.pathname === '/api/capacity/heartbeat') {
      return handleCapacityHeartbeat(request, env);
    }

    if (method === 'POST' && url.pathname === '/api/capacity/plan') {
      return handleCapacityPlan(request, env);
    }

    if (method === 'POST' && url.pathname === '/api/capacity/reconcile') {
      return handleCapacityReconcile(request, env);
    }

    if (method === 'POST' && url.pathname === '/api/capacity/verify-plan') {
      return handleCapacityVerifyPlan(request, env);
    }

    if (method === 'POST' && url.pathname === '/api/capacity/verify-resolve') {
      return handleCapacityVerifyResolve(request, env);
    }

    if (method === 'POST' && url.pathname === '/api/capacity/verify/start') {
      return handleCapacityVerifyStart(request, env);
    }

    if (method === 'POST' && url.pathname === '/api/capacity/verify/result') {
      return handleCapacityVerifyResult(request, env);
    }

    if (method === 'GET' && url.pathname === '/api/capacity/verify/status') {
      return handleCapacityVerifyStatus(request, env);
    }

    if (method === 'POST' && url.pathname === '/api/capacity/dispatch') {
      return handleCapacityDispatch(request, env);
    }

    if (method === 'POST' && url.pathname === '/api/capacity/release') {
      return handleCapacityRelease(request, env);
    }

    if (method === 'GET' && url.pathname === '/api/capacity/leases/summary') {
      return handleCapacityLeaseSummary(env);
    }

    if (method === 'POST' && url.pathname === '/api/worker/identity/bootstrap') {
      return handleWorkerIdentityBootstrap(request, env);
    }

    if (method === 'POST' && url.pathname === '/api/worker/identity/rotate') {
      return handleWorkerIdentityRotate(request, env);
    }

    if (method === 'POST' && url.pathname === '/api/worker/heartbeat') {
      return handleHeartbeat(request, env);
    }

    if (method === 'POST' && url.pathname === '/api/worker/claim') {
      return handleClaim(request, env);
    }

    if (method === 'POST' && url.pathname === '/api/worker/result') {
      return handleResult(request, env);
    }

    if (url.pathname === '/mcp-secure' || url.pathname === '/mcp') {
      const metadataPath = url.pathname === '/mcp-secure'
        ? '/.well-known/oauth-protected-resource/mcp-secure'
        : '/.well-known/oauth-protected-resource/mcp';
      if (!(await clientAuthorized(request, '', env))) return mcpChallenge(metadataPath);
      if (method === 'GET') {
        return reply({
          ok:true,
          service:'V-ONE Master MCP',
          version:'2.4.7-worker-identity-r1-compat',
          continuity:'R4',
          canonical:true,
          auth:'oauth2-required',
          tools:toolDefinitions().map(t=>t.name),
          oauth_resource_metadata:MCP_PUBLIC_ORIGIN+metadataPath
        });
      }
      if (method === 'POST') return handleMcp(request, env, '');
    }

    if (url.pathname === '/mcp-public' || url.pathname.startsWith('/mcp-public/')) {
      const pathToken = url.pathname === '/mcp-public'
        ? ''
        : decodeURIComponent(url.pathname.slice('/mcp-public/'.length));
      if (method === 'GET') {
        return reply({
          ok:true,
          service:'V-ONE Master MCP Public Bootstrap',
          version:'2.4.7-worker-identity-r1-compat',
          continuity:'R4',
          canonical:false,
          auth:'none',
          public_tools:Array.from(MCP_PUBLIC_TOOLS)
        });
      }
      if (method === 'POST') return handleMcp(request, env, pathToken, true);
    }

    return reply({ error: 'Not found' }, 404);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(Promise.all([evaluateCapacityHA(env), ensureCloudAiRoute(env), cleanupOldJobs(env)]));
  }
};
