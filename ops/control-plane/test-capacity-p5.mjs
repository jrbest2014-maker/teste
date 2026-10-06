import assert from 'node:assert/strict';
import { canonicalVerificationJson, evaluateVerificationHashes } from './src/capacity-broker.mjs';
import crypto from 'node:crypto';

const hash=v=>crypto.createHash('sha256').update(canonicalVerificationJson(v)).digest('hex');

const a={a:1,b:{x:2,y:[3,4]}};
const b={b:{y:[3,4],x:2},a:1};
const c={a:1,b:{x:999,y:[3,4]}};

assert.equal(canonicalVerificationJson(a),canonicalVerificationJson(b));
assert.equal(hash(a),hash(b));
assert.notEqual(hash(a),hash(c));

const waiting=evaluateVerificationHashes([
  {status:'COMPLETED',result_hash:hash(a)}
],2);
assert.equal(waiting.status,'WAITING');

const consensus=evaluateVerificationHashes([
  {status:'COMPLETED',result_hash:hash(a)},
  {status:'COMPLETED',result_hash:hash(b)}
],2);
assert.equal(consensus.status,'CONSENSUS');
assert.equal(consensus.reason,'ALL_RESULTS_MATCH');

const conflict=evaluateVerificationHashes([
  {status:'COMPLETED',result_hash:hash(a)},
  {status:'COMPLETED',result_hash:hash(c)}
],2);
assert.equal(conflict.status,'HOLD_VALIDATION_REQUIRED');
assert.equal(conflict.reason,'RESULT_DIVERGENCE');

const failed=evaluateVerificationHashes([
  {status:'COMPLETED',result_hash:hash(a)},
  {status:'FAILED'}
],2);
assert.equal(failed.status,'HOLD_VALIDATION_REQUIRED');
assert.equal(failed.reason,'MEMBER_FAILURE');

console.log('P5_CANONICAL_JSON=PASS');
console.log('P5_CONSENSUS=PASS');
console.log('P5_CONFLICT_HOLD=PASS');
console.log('P5_MEMBER_FAILURE_HOLD=PASS');
