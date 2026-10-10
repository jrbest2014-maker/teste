import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  WORKER_IDENTITY_PROTOCOL,
  authenticateWorkerIdentity,
  authorizeWorkerRequest,
  issueWorkerIdentity,
  revokeWorkerIdentity,
  rotateWorkerIdentity,
} from './vone_worker_identity';

const issued = issueWorkerIdentity({
  workerId: 'desktop-445339e-01',
  label: 'DESKTOP-445339E worker 01',
  capabilities: ['vone_executor_execute', 'ollama', 'ollama'],
  now: 1000,
});
assert.equal(issued.record.protocol, WORKER_IDENTITY_PROTOCOL);
assert.equal(issued.record.status, 'ACTIVE');
assert.deepEqual(issued.record.capabilities, ['ollama', 'vone_executor_execute']);
assert.ok(issued.token.startsWith('vone_wkr_'));
assert.ok(!JSON.stringify(issued.record).includes(issued.token), 'plaintext token must never be persisted in record');
assert.equal(authenticateWorkerIdentity(issued.record, issued.token), true);
assert.equal(authenticateWorkerIdentity(issued.record, issued.token + 'x'), false);

const rotated = rotateWorkerIdentity(issued.record, 2000);
assert.equal(rotated.record.generation, 2);
assert.equal(rotated.record.rotatedAt, 2000);
assert.equal(authenticateWorkerIdentity(rotated.record, issued.token), false, 'rotation must invalidate old token');
assert.equal(authenticateWorkerIdentity(rotated.record, rotated.token), true);

const revoked = revokeWorkerIdentity(rotated.record, 3000);
assert.equal(revoked.status, 'REVOKED');
assert.equal(authenticateWorkerIdentity(revoked, rotated.token), false, 'revoked identity must fail closed');
assert.throws(() => rotateWorkerIdentity(revoked), /revoked worker/);

const native = authorizeWorkerRequest({
  records: [rotated.record],
  workerId: rotated.record.workerId,
  token: rotated.token,
  allowLegacyFallback: true,
  legacyTokenHash: createHash('sha256').update('legacy-token-value-that-is-long-enough').digest('hex'),
});
assert.equal(native.mode, 'IDENTITY_R1');

const legacyToken = 'legacy-token-value-that-is-long-enough';
const legacyHash = createHash('sha256').update(legacyToken).digest('hex');
assert.equal(authorizeWorkerRequest({
  records: [],
  workerId: 'legacy-worker',
  token: legacyToken,
  legacyTokenHash: legacyHash,
  allowLegacyFallback: true,
}).mode, 'LEGACY');
assert.equal(authorizeWorkerRequest({
  records: [],
  workerId: 'legacy-worker',
  token: legacyToken,
  legacyTokenHash: legacyHash,
  allowLegacyFallback: false,
}).mode, 'DENY');

const knownWorkerWrongToken = authorizeWorkerRequest({
  records: [rotated.record],
  workerId: rotated.record.workerId,
  token: legacyToken,
  legacyTokenHash: legacyHash,
  allowLegacyFallback: true,
});
assert.equal(knownWorkerWrongToken.mode, 'DENY', 'known R1 identity must never downgrade to legacy');

console.log('vone_worker_identity: all assertions passed');
