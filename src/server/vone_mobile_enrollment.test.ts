import assert from 'node:assert/strict';
import {
  startMobileEnrollment,
  type MobileDeviceRecord,
  type MobileDeviceStore,
} from './vone_mobile_enrollment';

class InMemoryDeviceStore implements MobileDeviceStore {
  private readonly rows = new Map<string, MobileDeviceRecord>();

  async get(deviceId: string): Promise<MobileDeviceRecord | null> {
    return this.rows.get(deviceId) ?? null;
  }

  async upsertPending(record: MobileDeviceRecord): Promise<void> {
    this.rows.set(record.deviceId, record);
  }

  // Simula o admin aprovando pelo painel (mobile-admin.mjs: SET status='APPROVED').
  approve(deviceId: string, now: number, accessWindowMs: number): void {
    const row = this.rows.get(deviceId);
    if (!row) throw new Error('device not found');
    this.rows.set(deviceId, {
      ...row,
      status: 'APPROVED',
      approvedAt: now,
      accessExpiresAt: now + accessWindowMs,
      pairingCode: null,
    });
  }

  revoke(deviceId: string): void {
    const row = this.rows.get(deviceId);
    if (!row) throw new Error('device not found');
    this.rows.set(deviceId, { ...row, status: 'REVOKED', revokedAt: Date.now() });
  }
}

const VALID_SECRET_HASH = 'a'.repeat(64);
const OTHER_SECRET_HASH = 'b'.repeat(64);
const DEVICE_ID = 'ios-11111111-1111-1111-1111-111111111111';

function depsAt(nowMs: number, codes: string[]) {
  let i = 0;
  return {
    now: () => nowMs,
    generatePairingCode: () => codes[Math.min(i++, codes.length - 1)],
  };
}

async function main() {
  // Dispositivo novo: gera código e marca PENDING.
  {
    const store = new InMemoryDeviceStore();
    const result = await startMobileEnrollment(
      { deviceId: DEVICE_ID, secretHash: VALID_SECRET_HASH, label: 'iPhone', userId: 'user-1' },
      store,
      depsAt(1_000, ['111111']),
    );
    assert.equal(result.ok, true);
    assert.equal((result as any).status, 'PENDING');
    assert.equal((result as any).pairingCode, '111111');
  }

  // O BUG REAL, reproduzido: sem o conserto, reconectar com o mesmo
  // dispositivo/segredo enquanto ainda PENDING geraria um código NOVO,
  // invalidando o que o admin está olhando na tela de aprovação. Com o
  // conserto (já aplicado em vone_mobile_enrollment.ts), o código
  // devolvido na reconexão é o MESMO.
  {
    const store = new InMemoryDeviceStore();
    const first = await startMobileEnrollment(
      { deviceId: DEVICE_ID, secretHash: VALID_SECRET_HASH, label: 'iPhone', userId: 'user-1' },
      store,
      depsAt(1_000, ['111111']),
    );
    assert.equal((first as any).pairingCode, '111111');

    // App relança (iOS evictou em background) 30s depois, ainda dentro da
    // janela de 10min, mesmo device_id/secret_hash - exatamente o cenário
    // relatado pelo usuário (reconexão pedindo autenticação de novo).
    const second = await startMobileEnrollment(
      { deviceId: DEVICE_ID, secretHash: VALID_SECRET_HASH, label: 'iPhone', userId: 'user-1' },
      store,
      depsAt(31_000, ['222222']), // se o bug existisse, geraria 222222
    );
    assert.equal(second.ok, true);
    assert.equal((second as any).status, 'PENDING');
    assert.equal(
      (second as any).pairingCode,
      '111111',
      'reconexão com o mesmo dispositivo/segredo PENDING deve devolver o MESMO código - esse é o conserto do bug real',
    );

    // O admin, olhando o código 111111 no painel, consegue aprovar mesmo
    // depois da reconexão - sem esse conserto, a aprovação falharia com
    // "código não confere" porque o store já teria 222222.
    store.approve(DEVICE_ID, 60_000, 7 * 24 * 60 * 60 * 1000);
    const afterApproval = await startMobileEnrollment(
      { deviceId: DEVICE_ID, secretHash: VALID_SECRET_HASH, label: 'iPhone', userId: 'user-1' },
      store,
      depsAt(90_000, ['333333']),
    );
    assert.equal((afterApproval as any).status, 'APPROVED');
  }

  // Pareamento expirado: aí sim deve gerar código novo (comportamento correto, não é o bug).
  {
    const store = new InMemoryDeviceStore();
    await startMobileEnrollment(
      { deviceId: DEVICE_ID, secretHash: VALID_SECRET_HASH, label: 'iPhone', userId: 'user-1' },
      store,
      depsAt(1_000, ['111111']),
    );
    const afterExpiry = await startMobileEnrollment(
      { deviceId: DEVICE_ID, secretHash: VALID_SECRET_HASH, label: 'iPhone', userId: 'user-1' },
      store,
      depsAt(1_000 + 11 * 60 * 1000, ['444444']), // 11min depois, passou da janela de 10min
    );
    assert.equal((afterExpiry as any).pairingCode, '444444', 'código expirado deve ser trocado, não reaproveitado');
  }

  // Segredo diferente pro mesmo device_id -> já registrado, 409.
  {
    const store = new InMemoryDeviceStore();
    await startMobileEnrollment(
      { deviceId: DEVICE_ID, secretHash: VALID_SECRET_HASH, label: 'iPhone', userId: 'user-1' },
      store,
      depsAt(1_000, ['111111']),
    );
    const result = await startMobileEnrollment(
      { deviceId: DEVICE_ID, secretHash: OTHER_SECRET_HASH, label: 'iPhone', userId: 'user-1' },
      store,
      depsAt(2_000, ['999999']),
    );
    assert.equal(result.ok, false);
    assert.equal((result as any).error, 'device_already_registered');
    assert.equal((result as any).httpStatus, 409);
  }

  // Dispositivo revogado -> nunca reaproveita, sempre 403.
  {
    const store = new InMemoryDeviceStore();
    await startMobileEnrollment(
      { deviceId: DEVICE_ID, secretHash: VALID_SECRET_HASH, label: 'iPhone', userId: 'user-1' },
      store,
      depsAt(1_000, ['111111']),
    );
    store.revoke(DEVICE_ID);
    const result = await startMobileEnrollment(
      { deviceId: DEVICE_ID, secretHash: VALID_SECRET_HASH, label: 'iPhone', userId: 'user-1' },
      store,
      depsAt(2_000, ['555555']),
    );
    assert.equal(result.ok, false);
    assert.equal((result as any).error, 'device_revoked_new_device_identity_required');
    assert.equal((result as any).httpStatus, 403);
  }

  // Dispositivo já vinculado a outra conta -> 403, sem vazar pareamento cross-account.
  {
    const store = new InMemoryDeviceStore();
    await startMobileEnrollment(
      { deviceId: DEVICE_ID, secretHash: VALID_SECRET_HASH, label: 'iPhone', userId: 'user-1' },
      store,
      depsAt(1_000, ['111111']),
    );
    const result = await startMobileEnrollment(
      { deviceId: DEVICE_ID, secretHash: VALID_SECRET_HASH, label: 'iPhone', userId: 'user-2' },
      store,
      depsAt(2_000, ['666666']),
    );
    assert.equal(result.ok, false);
    assert.equal((result as any).error, 'device_bound_to_another_account');
  }

  // device_id/secret_hash mal formado -> 400, nunca chega a tocar o store.
  {
    const store = new InMemoryDeviceStore();
    const result = await startMobileEnrollment(
      { deviceId: 'x', secretHash: 'not-hex', label: 'iPhone', userId: null },
      store,
      depsAt(1_000, ['111111']),
    );
    assert.equal(result.ok, false);
    assert.equal((result as any).error, 'invalid_device_enrollment');
    assert.equal(await store.get('x'), null);
  }

  console.log(JSON.stringify({
    test: 'VONE_MOBILE_ENROLLMENT_R1',
    status: 'PASS',
    pairing_code_regression_reproduced_and_fixed: true,
    approval_survives_reconnect: true,
    expired_code_rotates: true,
    revoked_device_blocked: true,
    cross_account_blocked: true,
    invalid_input_rejected: true,
  }));
}

main().catch((e) => { console.error(e); process.exit(1); });
