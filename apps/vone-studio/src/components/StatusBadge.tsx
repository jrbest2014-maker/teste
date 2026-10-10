import type { GateStatus, RouteBadge, RouteState } from '../types/vone';
import './StatusBadge.css';

const STATE_LABEL: Record<RouteState, string> = {
  FREE_AVAILABLE: 'livre',
  FREE_QUEUE: 'na fila',
  FREE_QUOTA_LOW: 'cota baixa',
  FREE_EXHAUSTED: 'cota esgotada',
  PAID_BLOCKED: 'pago bloqueado',
  OFFLINE: 'offline',
};

const STATE_TONE: Record<RouteState, 'success' | 'warning' | 'danger' | 'muted'> = {
  FREE_AVAILABLE: 'success',
  FREE_QUEUE: 'warning',
  FREE_QUOTA_LOW: 'warning',
  FREE_EXHAUSTED: 'danger',
  PAID_BLOCKED: 'danger',
  OFFLINE: 'muted',
};

export function RouteStatusBadge({ route }: { route: RouteBadge }) {
  const tone = STATE_TONE[route.state];
  return (
    <span className={`vone-badge vone-badge--${tone}`} title={`Estado da rota: ${STATE_LABEL[route.state]}`}>
      <span className="vone-badge__dot" aria-hidden="true" />
      <strong>{route.profile}</strong>
      <span className="vone-badge__sep">·</span>
      <code>{route.model}</code>
    </span>
  );
}

export function GateChips({ gates }: { gates: GateStatus }) {
  return (
    <div className="vone-gate-chips" role="group" aria-label="Gates de segurança e custo">
      <span className="vone-chip vone-chip--danger" title="Rotas pagas nunca são selecionadas automaticamente">
        PAID_BLOCKED · {gates.paidBlocked}
      </span>
      <span
        className={`vone-chip ${gates.unknownCost === 'HOLD' ? 'vone-chip--warning' : 'vone-chip--success'}`}
        title="Custo desconhecido trava a rota em vez de assumir grátis"
      >
        UNKNOWN_COST · {gates.unknownCost}
      </span>
      <span
        className={`vone-chip ${gates.physicalOutput === 'LOCKED' ? 'vone-chip--danger' : 'vone-chip--success'}`}
        title="Saída física real (fora do sandbox) trancada por padrão"
      >
        PHYSICAL_OUTPUT · {gates.physicalOutput}
      </span>
    </div>
  );
}
