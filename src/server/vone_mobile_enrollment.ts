/**
 * Lógica de pareamento de dispositivo móvel (celular pedindo aprovação,
 * admin aprovando pelo código de 6 dígitos) - reimplementada de forma
 * isolada e testável a partir do que existe hoje no Worker ao vivo
 * (ver AGENTS.md, "Bug real encontrado em 2026-10-10": snapshot em
 * cloudflare-control-plane/src/mobile-pwa.mjs, branch
 * origin/chatgpt/worker-identity-r1, não mergeada).
 *
 * Esta versão já tem o conserto aplicado e testado
 * (vone_mobile_enrollment.test.ts): um dispositivo que reconecta
 * enquanto ainda está PENDING, com o MESMO segredo, recebe de volta o
 * mesmo código de pareamento em vez de um novo - é isso que impedia o
 * admin de aprovar (o código que ele via na tela virava inválido a cada
 * reconexão do celular).
 *
 * A interface MobileDeviceStore abstrai o D1 real (env.DB.prepare(...))
 * pra rodar sem nenhuma dependência de Cloudflare - só trocar a
 * implementação por uma que fala com D1 de verdade pra portar isto pro
 * Worker ao vivo.
 */

export type MobileDeviceStatus = 'PENDING' | 'APPROVED' | 'REVOKED';

export interface MobileDeviceRecord {
  readonly deviceId: string;
  readonly secretHash: string;
  readonly label: string;
  readonly status: MobileDeviceStatus;
  readonly pairingCode: string | null;
  readonly createdAt: number;
  readonly enrollExpiresAt: number | null;
  readonly approvedAt: number | null;
  readonly accessExpiresAt: number | null;
  readonly lastSeenAt: number | null;
  readonly revokedAt: number | null;
  readonly userId: string | null;
}

export interface MobileDeviceStore {
  get(deviceId: string): Promise<MobileDeviceRecord | null>;
  upsertPending(record: MobileDeviceRecord): Promise<void>;
}

export interface EnrollmentRequest {
  readonly deviceId: string;
  readonly secretHash: string;
  readonly label: string;
  readonly userId: string | null;
}

export type EnrollmentResult =
  | { readonly ok: true; readonly status: 'APPROVED'; readonly deviceId: string }
  | {
      readonly ok: true;
      readonly status: 'PENDING';
      readonly deviceId: string;
      readonly pairingCode: string;
      readonly expiresAt: number;
    }
  | { readonly ok: false; readonly error: string; readonly httpStatus: number };

export interface EnrollmentDeps {
  readonly now: () => number;
  readonly generatePairingCode: () => string;
  readonly enrollWindowMs?: number;
}

const DEFAULT_ENROLL_WINDOW_MS = 10 * 60 * 1000;

function isValidDeviceId(value: string): boolean {
  return /^[a-zA-Z0-9._:-]{8,96}$/.test(value);
}

function isValidSecretHash(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

export async function startMobileEnrollment(
  request: EnrollmentRequest,
  store: MobileDeviceStore,
  deps: EnrollmentDeps,
): Promise<EnrollmentResult> {
  if (!isValidDeviceId(request.deviceId) || !isValidSecretHash(request.secretHash)) {
    return { ok: false, error: 'invalid_device_enrollment', httpStatus: 400 };
  }

  const now = deps.now();
  const enrollWindowMs = deps.enrollWindowMs ?? DEFAULT_ENROLL_WINDOW_MS;
  const existing = await store.get(request.deviceId);

  if (existing?.status === 'REVOKED') {
    return { ok: false, error: 'device_revoked_new_device_identity_required', httpStatus: 403 };
  }
  if (existing && existing.userId && existing.userId !== request.userId) {
    return { ok: false, error: 'device_bound_to_another_account', httpStatus: 403 };
  }
  if (existing && existing.secretHash !== request.secretHash) {
    return { ok: false, error: 'device_already_registered', httpStatus: 409 };
  }

  if (
    existing &&
    existing.secretHash === request.secretHash &&
    existing.status === 'APPROVED' &&
    Number(existing.accessExpiresAt ?? 0) > now
  ) {
    return { ok: true, status: 'APPROVED', deviceId: request.deviceId };
  }

  // O conserto: mesmo dispositivo, mesmo segredo, ainda PENDING e dentro
  // da janela -> devolve o código já emitido, nunca gera um novo aqui.
  if (
    existing &&
    existing.secretHash === request.secretHash &&
    existing.status === 'PENDING' &&
    existing.pairingCode &&
    Number(existing.enrollExpiresAt ?? 0) > now
  ) {
    return {
      ok: true,
      status: 'PENDING',
      deviceId: request.deviceId,
      pairingCode: existing.pairingCode,
      expiresAt: existing.enrollExpiresAt as number,
    };
  }

  const pairingCode = deps.generatePairingCode();
  const enrollExpiresAt = now + enrollWindowMs;
  await store.upsertPending({
    deviceId: request.deviceId,
    secretHash: request.secretHash,
    label: request.label,
    status: 'PENDING',
    pairingCode,
    createdAt: now,
    enrollExpiresAt,
    approvedAt: null,
    accessExpiresAt: null,
    lastSeenAt: existing?.lastSeenAt ?? null,
    revokedAt: null,
    userId: request.userId,
  });

  return { ok: true, status: 'PENDING', deviceId: request.deviceId, pairingCode, expiresAt: enrollExpiresAt };
}
