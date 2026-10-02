import assert from 'node:assert/strict';
import worker from './vone_cloud_worker';
const token = 'vone-cloud-test-token-that-is-long-enough';
const originalFetch = globalThis.fetch, originalLog = console.log;
let aiCalls = 0, availableNeurons = 9_500, includeOwnedHeartbeat = false;
function authorityPayload(): Record<string, unknown> {
  const now = new Date().toISOString();
  return { protocol: 'VONE_CAPACITY_SNAPSHOT_R1', generated_at: now, policy_id: 'VONE_ZERO_COST_DEFAULT', authority: 'VONE_MASTER', task: { task_class: 'LLM_FAST', privacy_class: 'PRIVATE' }, outcome: 'ROUTE_SELECTED', selected: { route_id: 'cloudflare-workers-ai', state: 'FREE_AVAILABLE', route: { route_id: 'cloudflare-workers-ai', kind: 'cloud', provider: 'cloudflare-workers-ai', state: 'FREE_AVAILABLE', cost: { billing_mode: 'included', variable_cost_allowed: false, verified_zero_cost: true }, quota: { confidence: 'verified' }, capabilities: { task_classes: ['LLM_FAST'], models: ['@cf/qwen/qwen2.5-coder-32b-instruct'] }, health: { observed_at: now, ttl_seconds: 120 }, security: { allowed_privacy_classes: ['PRIVATE'] } } }, invariants: { paid_blocked: 'INVIOLABLE', unknown_cost: 'HOLD', physical_output: 'LOCKED' }, neuron_budget: { protocol: 'VONE_NEURON_BUDGET_R1', state: 'FREE_AVAILABLE', availableForDispatch: availableNeurons, reserve: 500 }, ...(includeOwnedHeartbeat ? { owned_heartbeat: { role: 'OWNED_EXECUTOR', mode: 'ONLINE', capabilities: ['vone_executor_execute'], heartbeat_at: now } } : {}) };
}
async function main(): Promise<void> {
  globalThis.fetch = async () => new Response(JSON.stringify(authorityPayload()), { headers: { 'content-type': 'application/json' } });
  const env = { AI: { async run() { aiCalls++; return { response: 'direct-cloud-result' }; } }, VONE_INFERENCE_TOKEN: token };
  const headers = { authorization: ['Bearer', token].join(' '), 'content-type': 'application/json' }, logs: string[] = [];
  console.log = (line?: unknown) => { logs.push(String(line)); };
  try {
    assert.equal((await worker.fetch(new Request('https://worker.test/health'), env)).status, 200);
    assert.equal((await (await worker.fetch(new Request('https://worker.test/status'), env)).json() as Record<string, unknown>).status, 'FREE_AVAILABLE');
    assert.equal((await worker.fetch(new Request('https://worker.test/delegate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'FAST', prompt: 'test' }) }), env)).status, 401);
    const delegated = await worker.fetch(new Request('https://worker.test/delegate', { method: 'POST', headers, body: JSON.stringify({ mode: 'FAST', prompt: 'test', max_tokens: 1 }) }), env);
    const result = await delegated.json() as Record<string, unknown>;
    for (const [key, value] of Object.entries({ protocol: 'VONE_DELEGATE_EXECUTE_R1', status: 'DONE', target: 'CLOUD_FREE', route: 'cloudflare-workers-ai', paid_fallback: false, appdeploy_required: false })) assert.equal(result[key], value);
    assert.equal((await (await worker.fetch(new Request('https://worker.test/infer', { method: 'POST', headers, body: JSON.stringify({ prompt: 'legacy route', max_tokens: 1 }) }), env)).json() as Record<string, unknown>).status, 'DONE');
    const smart = await worker.fetch(new Request('https://worker.test/delegate', { method: 'POST', headers, body: JSON.stringify({ mode: 'SMART', prompt: 'do not dispatch' }) }), env);
    assert.equal((await smart.json() as Record<string, unknown>).status, 'HOLD'); assert.equal(aiCalls, 2);
    includeOwnedHeartbeat = true;
    assert.equal((await (await worker.fetch(new Request('https://worker.test/recovery', { headers }), env)).json() as Record<string, unknown>).status, 'READY');
    const cron: Promise<unknown>[] = []; worker.scheduled({}, env, { waitUntil(promise) { cron.push(promise); } }); await Promise.all(cron); assert.equal(logs.length, 1);
    availableNeurons = 1;
    const blocked = await worker.fetch(new Request('https://worker.test/delegate', { method: 'POST', headers, body: JSON.stringify({ mode: 'AUTO', prompt: 'budget gate', max_tokens: 1 }) }), env);
    assert.equal((await blocked.json() as Record<string, unknown>).status, 'HOLD'); assert.equal(aiCalls, 2);
    console.log = originalLog; originalLog('vone_cloud_worker: all assertions passed');
  } finally { globalThis.fetch = originalFetch; console.log = originalLog; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });