/*
  Vocabulário compartilhado com o backend (src/server/vone_model_router.ts e
  src/server/vone_capacity_snapshot.ts). A UI nunca inventa um estado que o
  motor não tenha - estes tipos existem pra forçar isso em tempo de
  compilação. Quando o cliente real (Master) estiver plugado, estes tipos
  devem continuar espelhando os de lá.
*/

export type RouteState =
  | 'FREE_AVAILABLE'
  | 'FREE_QUEUE'
  | 'FREE_QUOTA_LOW'
  | 'FREE_EXHAUSTED'
  | 'PAID_BLOCKED'
  | 'OFFLINE';

export interface GateStatus {
  readonly paidBlocked: 'INVIOLABLE';
  readonly unknownCost: 'HOLD' | 'VERIFIED';
  readonly physicalOutput: 'LOCKED' | 'UNLOCKED';
}

export interface RouteBadge {
  readonly profile: 'FAST' | 'AUTO' | 'SMART' | 'MAX';
  readonly model: string;
  readonly state: RouteState;
}

export type ToolCallStatus = 'running' | 'done' | 'error' | 'blocked';

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly status: ToolCallStatus;
  readonly output?: string;
  readonly blockReason?: string;
}

export type MessageRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  readonly id: string;
  readonly role: MessageRole;
  readonly text: string;
  readonly createdAt: string;
  readonly route?: RouteBadge;
  readonly toolCalls?: readonly ToolCall[];
}

export interface Session {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly messages: readonly ChatMessage[];
}

export type FsNodeKind = 'file' | 'dir';

export interface FsNode {
  readonly name: string;
  readonly path: string;
  readonly kind: FsNodeKind;
  readonly children?: readonly FsNode[];
}

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly root: FsNode;
}
