import assert from 'node:assert/strict';
import { OpenRouterFreeInferenceBackend, GroqFreeInferenceBackend, ExternalInferencePolicyError } from './vone_external_inference_backends';

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function main() {
  const openrouter = new OpenRouterFreeInferenceBackend(
    'x'.repeat(32),
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    async model => model.endsWith(':free'),
    async () => jsonResponse({ model: 'nvidia/nemotron-3-ultra-550b-a55b:free', choices: [{ message: { content: 'ok-550' } }] }),
  );
  assert.equal((await openrouter.run('x', 32)).text, 'ok-550');

  const blockedOpenrouter = new OpenRouterFreeInferenceBackend('x'.repeat(32), 'paid/model', async () => false, async () => jsonResponse({}));
  await assert.rejects(() => blockedOpenrouter.run('x', 32), (error: unknown) => error instanceof ExternalInferencePolicyError && error.code === 'FREE_MODEL_NOT_VERIFIED');

  const groqBlocked = new GroqFreeInferenceBackend('x'.repeat(32), false);
  await assert.rejects(() => groqBlocked.run('x', 32), (error: unknown) => error instanceof ExternalInferencePolicyError && error.code === 'FREE_TIER_NOT_VERIFIED');

  const groq = new GroqFreeInferenceBackend(
    'x'.repeat(32),
    true,
    'openai/gpt-oss-120b',
    async () => jsonResponse({ model: 'openai/gpt-oss-120b', choices: [{ message: { content: 'ok-120' } }] }),
  );
  assert.equal((await groq.run('x', 32)).text, 'ok-120');
  console.log('vone_external_inference_backends: all assertions passed');
}
main().catch(error => { console.error(error); process.exit(1); });
