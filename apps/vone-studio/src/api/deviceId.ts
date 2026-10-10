const STORAGE_KEY = 'vone-device-id';

/**
 * device_id estável por navegador, igual ao conceito já usado pelo app
 * mobile existente (ver AGENTS.md: /api/mobile/history é consultado por
 * device_id). Não é credencial - é só um identificador de cliente gerado
 * localmente, então não cai na regra de nunca manusear token/credencial
 * Cloudflare.
 */
export function getOrCreateDeviceId(): string {
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const id = `vone-studio-${crypto.randomUUID()}`;
    localStorage.setItem(STORAGE_KEY, id);
    return id;
  } catch {
    // localStorage pode falhar (modo privado, storage bloqueado) - cai pra
    // um id de sessão em memória em vez de quebrar o app.
    return `vone-studio-ephemeral-${Math.random().toString(36).slice(2)}`;
  }
}
