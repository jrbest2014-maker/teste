import type { ChatMessage, FsNode, GateStatus, Session, Workspace } from '../types/vone';

export const MOCK_GATES: GateStatus = {
  paidBlocked: 'INVIOLABLE',
  unknownCost: 'HOLD',
  physicalOutput: 'LOCKED',
};

const workspaceTree: FsNode = {
  name: 'teste',
  path: '/',
  kind: 'dir',
  children: [
    {
      name: 'src',
      path: '/src',
      kind: 'dir',
      children: [
        { name: 'core', path: '/src/core', kind: 'dir', children: [] },
        { name: 'server', path: '/src/server', kind: 'dir', children: [] },
        { name: 'cloudflare', path: '/src/cloudflare', kind: 'dir', children: [] },
      ],
    },
    { name: 'AGENTS.md', path: '/AGENTS.md', kind: 'file' },
    { name: 'package.json', path: '/package.json', kind: 'file' },
  ],
};

export const MOCK_WORKSPACES: Workspace[] = [
  { id: 'ws-teste', name: 'teste (núcleo V-ONE)', root: workspaceTree },
];

const messages: ChatMessage[] = [
  {
    id: 'm1',
    role: 'user',
    text: 'conta para mim como esta seu estado operacional?',
    createdAt: '2026-10-10T14:02:00Z',
  },
  {
    id: 'm2',
    role: 'assistant',
    text:
      'Estado Operacional:\nMissão: vone-master | Status: ACTIVE\nFase: VONE_CLOUDFLARE_ONLY_R1_PASS\nBloqueios ativos: nenhum (PAID_BLOCKED, HOLD e physical-output lock respeitados).',
    createdAt: '2026-10-10T14:02:04Z',
    route: { profile: 'MAX', model: '@cf/nvidia/nemotron-3-120b-a12b', state: 'FREE_AVAILABLE' },
    toolCalls: [
      {
        id: 't1',
        name: 'vone_status',
        input: { scope: 'mission' },
        status: 'done',
        output: '{"mission":"vone-master","status":"ACTIVE","revision":108}',
      },
    ],
  },
  {
    id: 'm3',
    role: 'user',
    text: 'quero que executemos uma tarefa real',
    createdAt: '2026-10-10T14:03:10Z',
  },
  {
    id: 'm4',
    role: 'assistant',
    text: 'Sem escopo claro, não há ação a executar. Defina a tarefa real (ex: consulta D1, deploy Worker, teste de inferência).',
    createdAt: '2026-10-10T14:03:13Z',
    route: { profile: 'MAX', model: '@cf/nvidia/nemotron-3-120b-a12b', state: 'FREE_AVAILABLE' },
  },
];

export const MOCK_SESSIONS: Session[] = [
  { id: 's1', title: 'Estado operacional da missão', updatedAt: '2026-10-10T14:03:13Z', messages },
  { id: 's2', title: 'Design do V-ONE Studio', updatedAt: '2026-10-10T12:40:00Z', messages: [] },
];
