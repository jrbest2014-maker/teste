import assert from 'node:assert/strict';
import { CORE_ECOSYSTEM, decidePromotion, normalizeSignals, sha256Text } from './vone_ecosystem_radar';

const safeEvidence = {
  testsPass: true,
  evalsPass: true,
  backwardCompatible: true,
  zeroCostVerified: true,
  securityNonRegressive: true,
  noKnownRegression: true,
} as const;

assert.equal(decidePromotion({
  vendor: 'openai',
  sourceId: 'openai-docs',
  kind: 'DOCS',
  summary: 'Additive documentation metadata',
  breaking: false,
  costImpact: 'NO_CHANGE',
  securityImpact: 'NO_CHANGE',
}).action, 'AUTO_PROMOTE');

assert.equal(decidePromotion({
  vendor: 'anthropic',
  sourceId: 'claude-model',
  kind: 'MODEL',
  summary: 'New Claude model candidate',
  breaking: false,
  costImpact: 'ZERO_COST_VERIFIED',
  securityImpact: 'NO_CHANGE',
}).action, 'SANDBOX_EVAL');

assert.equal(decidePromotion({
  vendor: 'anthropic',
  sourceId: 'claude-model',
  kind: 'MODEL',
  summary: 'Evaluated Claude model candidate',
  breaking: false,
  costImpact: 'ZERO_COST_VERIFIED',
  securityImpact: 'NO_CHANGE',
}, safeEvidence).action, 'AUTO_PROMOTE');

assert.equal(decidePromotion({
  vendor: 'mcp',
  sourceId: 'mcp-spec',
  kind: 'PROTOCOL',
  summary: 'Breaking protocol revision',
  breaking: true,
  costImpact: 'NO_CHANGE',
  securityImpact: 'IMPROVES',
}, safeEvidence).action, 'HOLD');

assert.equal(decidePromotion({
  vendor: 'ollama',
  sourceId: 'ollama-pricing',
  kind: 'PRICING',
  summary: 'Pricing changed',
  breaking: false,
  costImpact: 'PAID',
  securityImpact: 'NO_CHANGE',
}, safeEvidence).action, 'HOLD');

assert.equal(decidePromotion({
  vendor: 'github-copilot',
  sourceId: 'copilot-tool',
  kind: 'TOOL',
  summary: 'New tool but eval regression',
  breaking: false,
  costImpact: 'NO_CHANGE',
  securityImpact: 'NO_CHANGE',
}, { ...safeEvidence, evalsPass: false }).action, 'HOLD');

assert.deepEqual(CORE_ECOSYSTEM, ['openai','anthropic','ollama','meta-llama','github-copilot','mcp']);

const normalized = normalizeSignals(['  GPT-6  ', 'GPT-6', 'Claude   Code']);
assert.deepEqual(normalized, ['Claude Code', 'GPT-6']);
assert.equal(sha256Text('x').length, 64);

console.log('vone_ecosystem_radar: all assertions passed');
