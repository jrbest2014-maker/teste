import * as assert from 'node:assert';
import { CloudflareInferenceBackend, OllamaInferenceBackend } from './vone_inference_backends';
import { CloudInferenceBlockedError } from './vone_cloud_inference_policy';

async function main(): Promise<void> {
  const token = 'x'.repeat(32);
  const cloudFetch: typeof fetch = async (_input, init) => {
    assert.equal((init?.headers as Record<string,string>).Authorization, `Bearer ${token}`);
    assert.deepEqual(JSON.parse(String(init?.body)), { prompt: 'hello', max_tokens: 32 });
    return new Response(JSON.stringify({
      protocol: 'VONE_CLOUD_INFERENCE_R1', status: 'DONE', model: 'cloud-test',
      result: { response: 'cloud-ok', usage: { neurons: 3.1 } },
    }), { status: 200 });
  };
  const cloud = await new CloudflareInferenceBackend('https://example.invalid/infer', token, cloudFetch).run('hello', 32);
  assert.deepEqual(cloud, { text: 'cloud-ok', model: 'cloud-test', neurons: 3.1 });

  await assert.rejects(
    () => new CloudflareInferenceBackend('https://example.invalid/infer', undefined, cloudFetch).run('x', 1),
    (e: unknown) => e instanceof CloudInferenceBlockedError && e.code === 'CLOUD_AUTH_OR_POLICY_BLOCKED',
  );
  const quotaFetch: typeof fetch = async () => new Response('daily free allocation 3036', { status: 429 });
  await assert.rejects(
    () => new CloudflareInferenceBackend('https://example.invalid/infer', token, quotaFetch).run('x', 1),
    (e: unknown) => e instanceof CloudInferenceBlockedError && e.code === 'CLOUD_FREE_EXHAUSTED',
  );
  const missingUsage: typeof fetch = async () => new Response(JSON.stringify({
    protocol: 'VONE_CLOUD_INFERENCE_R1', status: 'DONE', model: 'x', result: { response: 'x', usage: {} },
  }), { status: 200 });
  await assert.rejects(() => new CloudflareInferenceBackend('https://example.invalid/infer', token, missingUsage).run('x', 1));

  const ollamaFetch: typeof fetch = async (input, init) => {
    assert.equal(String(input), 'http://127.0.0.1:11434/api/generate');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'v-one-coder:fast'); assert.equal(body.stream, false); assert.equal(body.options.num_predict, 8);
    return new Response(JSON.stringify({ response: 'local-ok', model: 'v-one-coder:fast' }), { status: 200 });
  };
  const local = await new OllamaInferenceBackend(undefined, undefined, ollamaFetch).run('hello', 8);
  assert.equal(local.text, 'local-ok'); assert.equal(local.model, 'v-one-coder:fast');
  console.log('vone_inference_backends: all assertions passed');
}
main().catch((e) => { console.error(e); process.exit(1); });
