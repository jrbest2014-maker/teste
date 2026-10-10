import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GateChips, RouteStatusBadge } from './StatusBadge';
import type { GateStatus, RouteBadge } from '../types/vone';

describe('RouteStatusBadge', () => {
  it('mostra o perfil e o modelo da rota', () => {
    const route: RouteBadge = { profile: 'MAX', model: '@cf/nvidia/nemotron-3-120b-a12b', state: 'FREE_AVAILABLE' };
    render(<RouteStatusBadge route={route} />);
    expect(screen.getByText('MAX')).toBeInTheDocument();
    expect(screen.getByText('@cf/nvidia/nemotron-3-120b-a12b')).toBeInTheDocument();
  });

  it('usa o tom de aviso (warning) pra cota baixa, não sucesso', () => {
    const route: RouteBadge = { profile: 'FAST', model: 'x', state: 'FREE_QUOTA_LOW' };
    const { container } = render(<RouteStatusBadge route={route} />);
    expect(container.querySelector('.vone-badge--warning')).toBeTruthy();
    expect(container.querySelector('.vone-badge--success')).toBeFalsy();
  });

  it('usa o tom de perigo (danger) pra PAID_BLOCKED', () => {
    const route: RouteBadge = { profile: 'FAST', model: 'x', state: 'PAID_BLOCKED' };
    const { container } = render(<RouteStatusBadge route={route} />);
    expect(container.querySelector('.vone-badge--danger')).toBeTruthy();
  });
});

describe('GateChips', () => {
  it('mostra os três gates com seus valores reais, nunca inventados', () => {
    const gates: GateStatus = { paidBlocked: 'INVIOLABLE', unknownCost: 'HOLD', physicalOutput: 'LOCKED' };
    render(<GateChips gates={gates} />);
    expect(screen.getByText(/PAID_BLOCKED/)).toBeInTheDocument();
    expect(screen.getByText(/INVIOLABLE/)).toBeInTheDocument();
    expect(screen.getByText(/UNKNOWN_COST/)).toBeInTheDocument();
    expect(screen.getByText(/HOLD/)).toBeInTheDocument();
    expect(screen.getByText(/PHYSICAL_OUTPUT · LOCKED/)).toBeInTheDocument();
  });

  it('troca a cor do chip de custo quando verificado como grátis', () => {
    const gates: GateStatus = { paidBlocked: 'INVIOLABLE', unknownCost: 'VERIFIED', physicalOutput: 'LOCKED' };
    const { container } = render(<GateChips gates={gates} />);
    const costChip = screen.getByText(/UNKNOWN_COST/);
    expect(costChip.className).toContain('vone-chip--success');
    expect(container.querySelectorAll('.vone-chip--danger')).toHaveLength(2); // paidBlocked + physicalOutput locked
  });
});
