import assert from 'node:assert/strict';
import { selectMonotonicPowerRoute, PowerRoute } from './vone_power_ladder';

const routes: PowerRoute[] = [
  { id: 'cloudflare-32b', provider: 'cloudflare', model: 'qwen-32b', capabilityB: 32, speedRank: 90, zeroCostVerified: true, state: 'AVAILABLE', external: false },
  { id: 'groq-120b', provider: 'groq', model: 'openai/gpt-oss-120b', capabilityB: 120, speedRank: 100, zeroCostVerified: true, state: 'AVAILABLE', external: true },
  { id: 'openrouter-550b', provider: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:free', capabilityB: 550, speedRank: 60, zeroCostVerified: true, state: 'AVAILABLE', external: true },
];

const from120 = selectMonotonicPowerRoute(routes, { profile: 'MAX', privacy: 'PUBLIC', allowExternalBurst: true, currentCapabilityB: 120 });
assert.equal(from120.selected?.id, 'openrouter-550b');

const from70 = selectMonotonicPowerRoute(routes, { profile: 'SMART', privacy: 'PUBLIC', allowExternalBurst: true, currentCapabilityB: 70 });
assert.equal(from70.selected?.id, 'groq-120b');

const noDowngrade = selectMonotonicPowerRoute(routes.slice(0, 2), { profile: 'MAX', privacy: 'PUBLIC', allowExternalBurst: true, currentCapabilityB: 120 });
assert.equal(noDowngrade.outcome, 'HOLD');

const privateWork = selectMonotonicPowerRoute(routes, { profile: 'SMART', privacy: 'PRIVATE', allowExternalBurst: true, currentCapabilityB: 70 });
assert.equal(privateWork.outcome, 'HOLD');

const paidOnly: PowerRoute[] = [
  { id: 'paid-1000b', provider: 'paid', model: 'huge', capabilityB: 1000, speedRank: 100, zeroCostVerified: false, state: 'PAID_BLOCKED', external: true },
];
assert.equal(selectMonotonicPowerRoute(paidOnly, { profile: 'MAX', privacy: 'PUBLIC', allowExternalBurst: true, currentCapabilityB: 120 }).outcome, 'HOLD');

const unknownOnly: PowerRoute[] = [
  { id: 'unknown', provider: 'x', model: 'mystery', capabilityB: null, speedRank: 100, zeroCostVerified: true, state: 'AVAILABLE', external: false },
];
assert.equal(selectMonotonicPowerRoute(unknownOnly, { profile: 'FAST', privacy: 'PUBLIC', allowExternalBurst: true }).outcome, 'HOLD');

console.log('vone_power_ladder: all assertions passed');
