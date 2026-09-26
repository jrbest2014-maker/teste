import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const WORKER_IDENTITY_PROTOCOL = 'VONE_WORKER_IDENTITY_R1' as const;

export type WorkerIdentityStatus = 'ACTIVE' | 'REVOKED';

export type WorkerIdentityRecord = {
  protocol: typeof WORKER_IDENTITY_PROTOCOL;
  workerId: string;
  label: string;
  tokenHash: string;
  status: WorkerIdentityStatus;
  generation: number;
  createdAt: number;
  rotatedAt?: number;
  revokedAt?: number;
  capabilities: string[];
};

export type IssuedWorkerIdentity = {
  token: string;
  record: WorkerIdentityRecord;
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validWorkerId(workerId: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,119}$/.test(workerId);
}

function normalizeCapabilities(capabilities: string[]): string[] {
  return [...new Set(capabilities.map(v => String(v).trim()).filter(Boolean))].sort();
}

export function issueWorkerIdentity(input: {
  workerId: string;
  label: string;
  capabilities?: string[];
  now?: number;
}): IssuedWorkerIdentity {
  if (!validWorkerId(input.workerId)) throw new Error('invalid workerId');
  const label = String(input.label || '').trim();
  if (!label) throw new Error('label required');
  const token = 'vone_wkr_' + randomBytes(48).toString('base64url');
  return {
    token,
    record: {
      protocol: WORKER_IDENTITY_PROTOCOL,
      workerId: input.workerId,
      label: label.slice(0, 120),
      tokenHash: sha256(token),
      status: 'ACTIVE',
      generation: 1,
      createdAt: input.now ?? Date.now(),
      capabilities: normalizeCapabilities(input.capabilities || []),
    },
  };
}

export function authenticateWorkerIdentity(record: WorkerIdentityRecord, token: string): boolean {
  if (record.protocol !== WORKER_IDENTITY_PROTOCOL || record.status !== 'ACTIVE') return false;
  if (!token || token.length < 32) return false;
  const actual = Buffer.from(sha256(token), 'hex');
  const expected = Buffer.from(record.tokenHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function rotateWorkerIdentity(record: WorkerIdentityRecord, now = Date.now()): IssuedWorkerIdentity {
  if (record.status !== 'ACTIVE') throw new Error('cannot rotate revoked worker');
  const token = 'vone_wkr_' + randomBytes(48).toString('base64url');
  return {
    token,
    record: {
      ...record,
      tokenHash: sha256(token),
      generation: record.generation + 1,
      rotatedAt: now,
    },
  };
}

export function revokeWorkerIdentity(record: WorkerIdentityRecord, now = Date.now()): WorkerIdentityRecord {
  return { ...record, status: 'REVOKED', revokedAt: now };
}

export function authorizeWorkerRequest(input: {
  records: WorkerIdentityRecord[];
  workerId: string;
  token: string;
  legacyTokenHash?: string;
  allowLegacyFallback?: boolean;
}): { ok: boolean; mode: 'IDENTITY_R1' | 'LEGACY' | 'DENY'; record?: WorkerIdentityRecord } {
  const record = input.records.find(r => r.workerId === input.workerId);
  if (record) {
    return authenticateWorkerIdentity(record, input.token)
      ? { ok: true, mode: 'IDENTITY_R1', record }
      : { ok: false, mode: 'DENY' };
  }
  if (input.allowLegacyFallback === true && input.legacyTokenHash && input.token) {
    const actual = Buffer.from(sha256(input.token), 'hex');
    const expected = Buffer.from(input.legacyTokenHash, 'hex');
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) return { ok: true, mode: 'LEGACY' };
  }
  return { ok: false, mode: 'DENY' };
}
