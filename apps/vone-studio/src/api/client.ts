import type { ChatMessage, GateStatus, Session, Workspace } from '../types/vone';
import { MOCK_GATES, MOCK_SESSIONS, MOCK_WORKSPACES } from './mockData';

export interface VOneApiClient {
  listWorkspaces(): Promise<Workspace[]>;
  listSessions(): Promise<Session[]>;
  getGateStatus(): Promise<GateStatus>;
  sendMessage(sessionId: string, text: string): Promise<ChatMessage>;
}

function delay<T>(value: T, ms = 300): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/**
 * Cliente mock: dados fixos em api/mockData.ts, sem rede. Usado por padrão
 * enquanto o contrato HTTP real do Master (vone-control-plane) não está
 * acessível desta sessão - ver HttpVOneApiClient abaixo para o que falta
 * pra trocar.
 */
export class MockVOneApiClient implements VOneApiClient {
  async listWorkspaces(): Promise<Workspace[]> {
    return delay(MOCK_WORKSPACES);
  }

  async listSessions(): Promise<Session[]> {
    return delay(MOCK_SESSIONS);
  }

  async getGateStatus(): Promise<GateStatus> {
    return delay(MOCK_GATES, 80);
  }

  async sendMessage(_sessionId: string, text: string): Promise<ChatMessage> {
    return delay(
      {
        id: `mock-${Date.now()}`,
        role: 'assistant',
        text: `(mock) recebido: "${text}". Plugue HttpVOneApiClient no Master pra resposta real.`,
        createdAt: new Date().toISOString(),
      },
      500,
    );
  }
}

/**
 * Cliente real contra o Master (vone-control-plane, fora deste repositório -
 * ver AGENTS.md, seção "O Master"). NÃO IMPLEMENTADO ainda porque o
 * contrato HTTP exato (autenticação, formato de resposta de
 * /api/mobile/history e do job vone_hub_chat) só existe no código vivo do
 * Worker, editado por Cloudflare Quick Edit, fora do alcance desta sessão.
 *
 * Para ligar de verdade:
 *   1. baseUrl = https://vone-control-plane.vone-technology.workers.dev
 *   2. GET  {baseUrl}/api/mobile/history?device_id=...  -> Session[]
 *   3. POST {baseUrl}/api/mobile/chat  { device_id, prompt } -> dispara o
 *      job vone_hub_chat (ver AGENTS.md: "Bug real corrigido em
 *      2026-10-10: /vone-mobile sem histórico de conversa" pro formato do
 *      prompt montado lá).
 *   4. Nunca colar token/credencial Cloudflare aqui no código nem no chat -
 *      injetar via variável de ambiente do build (import.meta.env), nunca
 *      hardcoded.
 */
export class HttpVOneApiClient implements VOneApiClient {
  constructor(private readonly baseUrl: string, private readonly deviceId: string) {}

  async listWorkspaces(): Promise<Workspace[]> {
    throw new Error('HttpVOneApiClient.listWorkspaces: contrato do Master ainda não confirmado nesta sessão.');
  }

  async listSessions(): Promise<Session[]> {
    throw new Error('HttpVOneApiClient.listSessions: contrato do Master ainda não confirmado nesta sessão.');
  }

  async getGateStatus(): Promise<GateStatus> {
    throw new Error('HttpVOneApiClient.getGateStatus: contrato do Master ainda não confirmado nesta sessão.');
  }

  async sendMessage(_sessionId: string, _text: string): Promise<ChatMessage> {
    throw new Error(
      `HttpVOneApiClient.sendMessage: falta confirmar contrato de ${this.baseUrl} para device ${this.deviceId}.`,
    );
  }
}
