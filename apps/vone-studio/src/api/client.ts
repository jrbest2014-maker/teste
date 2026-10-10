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
 * Cliente mock: dados fixos em api/mockData.ts, sem rede. Usado quando
 * nenhuma VITE_VONE_* está configurada no build (ver App.tsx).
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
        text: `(mock) recebido: "${text}". Configure VITE_VONE_MASTER_URL pra resposta real.`,
        createdAt: new Date().toISOString(),
      },
      500,
    );
  }
}

export interface HttpClientConfig {
  /** https://vone-control-plane.vone-technology.workers.dev - o Master. */
  readonly masterUrl?: string;
  /**
   * O Cloud Inference Worker deste repositório (src/cloudflare/vone_cloud_worker.ts).
   * Contrato 100% confirmado porque o código está aqui e tem teste
   * (vone_cloud_worker.test.ts) - não é inferência.
   */
  readonly cloudWorkerUrl?: string;
  readonly deviceId: string;
  /**
   * Caminho do POST que dispara o job vone_hub_chat. NÃO CONFIRMADO - não
   * existe em nenhum lugar lido por esta sessão (AGENTS.md só documenta o
   * GET /api/mobile/history). É um palpite seguindo a convenção do
   * endpoint irmão, pronto pra corrigir em uma linha assim que alguém
   * confirmar contra o Worker ao vivo (Cloudflare Quick Edit) ou contra uma
   * resposta real de rede.
   */
  readonly chatEndpointPath?: string;
}

interface CloudWorkerStatusResponse {
  authority?: {
    cloud_verified_zero_cost?: boolean;
    physical_output?: 'LOCKED' | 'UNLOCKED';
  };
}

function normalizeHistoryRow(row: unknown, index: number): ChatMessage | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const rawRole = String(r.role ?? r.sender ?? r.author ?? (index % 2 === 0 ? 'user' : 'assistant'));
  const role = rawRole === 'user' || rawRole === 'assistant' || rawRole === 'system' ? rawRole : 'assistant';
  const text = String(r.content ?? r.text ?? r.message ?? r.prompt ?? '');
  if (!text) return null;
  const createdAt = String(r.created_at ?? r.createdAt ?? r.timestamp ?? new Date().toISOString());
  return { id: String(r.id ?? `hist-${index}-${createdAt}`), role, text, createdAt };
}

/**
 * Cliente real. getGateStatus() é 100% contra contrato confirmado (o Cloud
 * Worker deste repositório). listSessions()/sendMessage() falam com o
 * Master (fora deste repositório) e foram implementados contra o que o
 * AGENTS.md documenta como bug real já investigado - mas não foram
 * verificados ao vivo nesta sessão porque:
 *   1. a política de rede deste ambiente bloqueia saída pra
 *      vone-control-plane.vone-technology.workers.dev (CONNECT 403 - ver
 *      "Network access" nas configurações do ambiente pra liberar);
 *   2. a ponte MCP pro Master (V-ONE_MASTER_AI) respondeu "Service
 *      Unavailable" e a outra ponte (v-one-master-cloudflare) devolveu o
 *      motivo real: D1_ERROR, limite diário de escrita do tier grátis
 *      excedido (reseta à meia-noite UTC; virar pra tier pago é decisão de
 *      custo do dono, nunca automática - PAID_BLOCKED=INVIOLABLE).
 * Assim que qualquer um dos dois abrir, uma chamada real confirma ou
 * corrige o shape abaixo - o código já está pronto pra rodar, não é um
 * stub.
 */
export class HttpVOneApiClient implements VOneApiClient {
  private readonly masterUrl: string;
  private readonly cloudWorkerUrl: string;
  private readonly deviceId: string;
  private readonly chatEndpointPath: string;

  constructor(config: HttpClientConfig) {
    this.masterUrl = (config.masterUrl ?? 'https://vone-control-plane.vone-technology.workers.dev').replace(/\/$/, '');
    this.cloudWorkerUrl = (
      config.cloudWorkerUrl ?? 'https://v-one-cloud-inference-r1.vone-technology.workers.dev'
    ).replace(/\/$/, '');
    this.deviceId = config.deviceId;
    this.chatEndpointPath = config.chatEndpointPath ?? '/api/mobile/chat';
  }

  async listWorkspaces(): Promise<Workspace[]> {
    // O Master não expõe codespace/pasta pela API mobile - isso é um
    // conceito do worker próprio (desktop, VOneVFSSandbox local). Lista
    // vazia é um estado real e tratável pela UI (Sidebar já mostra "Nenhuma
    // pasta aberta"), não um erro.
    return [];
  }

  async listSessions(): Promise<Session[]> {
    const response = await fetch(
      `${this.masterUrl}/api/mobile/history?device_id=${encodeURIComponent(this.deviceId)}`,
      { headers: { accept: 'application/json' } },
    );
    if (!response.ok) {
      throw new Error(`[MASTER] GET /api/mobile/history -> HTTP ${response.status}`);
    }
    const body: unknown = await response.json();
    const rows = Array.isArray(body)
      ? body
      : Array.isArray((body as Record<string, unknown>)?.messages)
        ? ((body as Record<string, unknown>).messages as unknown[])
        : Array.isArray((body as Record<string, unknown>)?.history)
          ? ((body as Record<string, unknown>).history as unknown[])
          : Array.isArray((body as Record<string, unknown>)?.rows)
            ? ((body as Record<string, unknown>).rows as unknown[])
            : [];
    const messages = rows.map(normalizeHistoryRow).filter((m): m is ChatMessage => m !== null);
    const lastUpdatedAt = messages.at(-1)?.createdAt ?? new Date().toISOString();
    return [{ id: `device-${this.deviceId}`, title: 'Conversa neste dispositivo', updatedAt: lastUpdatedAt, messages }];
  }

  async getGateStatus(): Promise<GateStatus> {
    const response = await fetch(`${this.cloudWorkerUrl}/status`, { headers: { accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`[CLOUD WORKER] GET /status -> HTTP ${response.status}`);
    }
    const body = (await response.json()) as CloudWorkerStatusResponse;
    return {
      paidBlocked: 'INVIOLABLE',
      unknownCost: body.authority?.cloud_verified_zero_cost === true ? 'VERIFIED' : 'HOLD',
      physicalOutput: body.authority?.physical_output === 'UNLOCKED' ? 'UNLOCKED' : 'LOCKED',
    };
  }

  async sendMessage(_sessionId: string, text: string): Promise<ChatMessage> {
    const response = await fetch(`${this.masterUrl}${this.chatEndpointPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ device_id: this.deviceId, prompt: text }),
    });
    if (!response.ok) {
      throw new Error(`[MASTER] POST ${this.chatEndpointPath} -> HTTP ${response.status}`);
    }
    const body = (await response.json()) as Record<string, unknown>;
    const replyText = String(body.response ?? body.text ?? body.result ?? '');
    return {
      id: `master-${Date.now()}`,
      role: 'assistant',
      text: replyText || '(resposta vazia do Master - confira o shape real em sendMessage())',
      createdAt: new Date().toISOString(),
    };
  }
}
