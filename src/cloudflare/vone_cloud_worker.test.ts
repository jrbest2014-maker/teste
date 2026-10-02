import assert from 'node:assert/strict';
import worker from './vone_cloud_worker';

const token = 'vone-cloud-test-token-that-is-long-enough';
const originalFetch = globalThis.fetch;
const originalLog = console.log;
let aiCalls = 0;
let masterCalls = 0;
let authorityMode: 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN' | 'INSUFFICIENT' | 'STALE' = 'AVAILABLE';
const logs: string[] = [];

function authorityPayload(): Record<string, unknown> {
  const result: Record<string, unknown> = {
    cloudAiExecution: 'FREE_AVAILABLE',
    cloudBudget: { remaining_neurons: 9_500, hard_cap_neurons: 10_000 },
  };
  if (authorityMode === 'UNKNOWN') result.cloudAiExecution = 'UNKNOWN';
  if (authorityMode === 'INSUFFICIENT') result.cloudBudget = { remaining_neurons: 500, hard_cap_neurons: 10_000 };
  if (authorityMode === 'STALE') result.updatedAt = new Date(Date.now() - 180_000).toISOString();
  return result;
}
function headers(): Record<string, string> { return { authorization: ['Bearer', token].join(' '), 'content-type': 'application/json' }; }
async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  return worker.fetch(new Request(`https://worker.test${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) }), env);
}
const env = { AI: { async run() { aiCalls++; return { response: 'direct-cloud-result' }; } }, VONE_INFERENCE_TOKEN: token };
async function main(): Promise<void> {
  globalThis.fetch = async () => {
    masterCalls++;
    if (authorityMode === 'UNAVAILABLE') throw new Error('Master offline');
    return new Response(JSON.stringify(authorityPayload()), { headers: { 'content-type': 'application/json' } });
  };
  console.log = (line?: unknown) => { logs.push(String(line)); };
  try {
    assert.equal((await worker.fetch(new Request('https://worker.test/health'), env)).status, 200);
    const status = await worker.fetch(new Request('https://worker.test/status'), env), statusPayload = await status.json() as Record<string, unknown>;
    assert.equal(statusPayload.protocol, 'VONE_CLOUD_CONTROL_STATUS_R2');
    assert.equal(statusPayload.architecture, 'CLOUDFLARE_DIRECT_CRITICAL_PATH_R2');
    assert.equal(statusPayload.appdeploy_required_for_fast, false);
    assert.equal((statusPayload.authority as Record<string, unknown>).protocol, 'VONE_DELEGATE_AUTHORITY_R2');
    assert.equal((await worker.fetch(new Request('https://worker.test/recovery'), env)).status, 401);
    const fast = await post('/delegate', { mode: 'FAST', prompt: 'test', max_tokens: 1 }), fastResult = await fast.json() as Record<string, unknown>;
    assert.equal(fastResult.protocol, 'VONE_DELEGATE_EXECUTE_R1'); assert.equal(fastResult.status, 'DONE'); assert.equal(fastResult.target, 'CLOUD_FREE');
    assert.equal(fastResult.route, 'cloudflare-workers-ai'); assert.equal(fastResult.paid_fallback, false); assert.equal(fastResult.appdeploy_required, false);
    assert.equal(fastResult.cloud_verified_zero_cost, true); assert.equal(fastResult.source, 'VONE_MASTER_CLOUDFLARE');
    assert.equal((fastResult.authority as Record<string, unknown>).protocol, 'VONE_DELEGATE_AUTHORITY_R2');
    authorityMode = 'UNAVAILABLE';
    const unavailable = await post('/delegate', { mode: 'AUTO', prompt: 'offline', max_tokens: 1 }), unavailableResult = await unavailable.json() as Record<string, unknown>;
    assert.equal(unavailableResult.status, 'HOLD'); assert.equal(unavailableResult.reason, 'MASTER_UNAVAILABLE'); assert.equal(unavailableResult.paid_fallback, false); assert.equal(aiCalls, 1);
    authorityMode = 'UNKNOWN';
    const unknown = await post('/delegate', { mode: 'FAST', prompt: 'unknown', max_tokens: 1 }), unknownResult = await unknown.json() as Record<string, unknown>;
    assert.equal(unknownResult.status, 'HOLD'); assert.equal(unknownResult.cloud_verified_zero_cost, false); assert.equal(unknownResult.unknown_cost, 'HOLD'); assert.equal(unknownResult.paid_fallback, false); assert.equal(aiCalls, 1);
    authorityMode = 'INSUFFICIENT';
    const insufficient = await post('/delegate', { mode: 'FAST', prompt: 'budget', max_tokens: 1 }), insufficientResult = await insufficient.json() as Record<string, unknown>;
    assert.equal(insufficientResult.status, 'HOLD'); assert.equal(insufficientResult.reason, 'NEURON_BUDGET_AFTER_RESERVE_INSUFFICIENT'); assert.equal(insufficientResult.protected_reserve_neurons, 1_000); assert.equal(aiCalls, 1);
    authorityMode = 'STALE';
    const stale = await post('/delegate', { mode: 'FAST', prompt: 'stale', max_tokens: 1 }); assert.equal((await stale.json() as Record<string, unknown>).reason, 'MASTER_STATUS_STALE'); assert.equal(aiCalls, 1);
    authorityMode = 'AVAILABLE';
    const internalOnly = await post('/delegate', { mode: 'FAST', prompt: 'x'.repeat(3_000), max_tokens: 10, estimated_neurons: 1 }), internalResult = await internalOnly.json() as Record<string, unknown>;
    assert.equal(internalResult.status, 'DONE'); assert.equal(internalResult.estimated_neurons, 77); assert.equal(internalResult.paid_fallback, false);
    const callerRaised = await post('/delegate', { mode: 'AUTO', prompt: 'small', max_tokens: 1, estimated_neurons: 100 }), callerRaisedResult = await callerRaised.json() as Record<string, unknown>;
    assert.equal(callerRaisedResult.status, 'DONE'); assert.equal(callerRaisedResult.estimated_neurons, 100); assert.equal(callerRaisedResult.paid_fallback, false);
    const inferenceSuccess = await post('/infer', { prompt: 'compatibility', max_tokens: 1 }), inferenceSuccessResult = await inferenceSuccess.json() as Record<string, unknown>;
    assert.equal(inferenceSuccessResult.protocol, 'VONE_CLOUD_INFERENCE_R1'); assert.equal(inferenceSuccessResult.status, 'DONE'); assert.equal(inferenceSuccessResult.paid_fallback, false);
    assert.equal((inferenceSuccessResult.authority as Record<string, unknown>).protocol, 'VONE_DELEGATE_AUTHORITY_R2');
    const callsBeforeSmart = aiCalls;
    for (const mode of ['SMART', 'MAX']) {
      const smart = await post('/delegate', { mode, prompt: 'no desktop' }), smartResult = await smart.json() as Record<string, unknown>;
      assert.equal(smartResult.status, 'HOLD'); assert.equal(smartResult.owned_fresh_heartbeat, false); assert.equal(smartResult.reason, 'VERIFIED_FRESH_OWNED_HEARTBEAT_REQUIRED'); assert.equal(smartResult.paid_fallback, false);
    }
    assert.equal(aiCalls, callsBeforeSmart);
    authorityMode = 'UNKNOWN';
    const inference = await post('/infer', { prompt: 'must gate', max_tokens: 1 }), inferenceResult = await inference.json() as Record<string, unknown>;
    assert.equal(inferenceResult.protocol, 'VONE_CLOUD_INFERENCE_R1'); assert.equal(inferenceResult.status, 'HOLD');
    assert.equal((inferenceResult.authority as Record<string, unknown>).protocol, 'VONE_DELEGATE_AUTHORITY_R2');
    assert.equal(inferenceResult.paid_fallback, false); assert.equal(inferenceResult.appdeploy_required, false); assert.equal(aiCalls, callsBeforeSmart);
    authorityMode = 'UNAVAILABLE';
    const recovery = await worker.fetch(new Request('https://worker.test/recovery', { headers: headers() }), env), recoveryResult = await recovery.json() as Record<string, unknown>;
    assert.equal(recoveryResult.protocol, 'VONE_CLOUD_RECOVERY_SNAPSHOT_R2'); assert.equal(recoveryResult.status, 'HOLD');
    const callsBeforeCron = masterCalls, cronPromises: Promise<unknown>[] = [];
    worker.scheduled({}, env, { waitUntil(promise) { cronPromises.push(promise); } }); await Promise.all(cronPromises);
    assert.equal(masterCalls, callsBeforeCron + 1); assert.equal(aiCalls, callsBeforeSmart);
    const logged = JSON.parse(logs.at(-1)!) as Record<string, unknown>;
    assert.equal(logged.protocol, 'VONE_CLOUD_RECOVERY_SNAPSHOT_R2'); assert.equal(logged.paid_fallback, false);
    console.log = originalLog; originalLog('vone_cloud_worker: all assertions passed');
  } finally { globalThis.fetch = originalFetch; console.log = originalLog; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });