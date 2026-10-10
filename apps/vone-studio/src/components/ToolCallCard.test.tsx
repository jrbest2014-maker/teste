import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToolCallCard } from './ToolCallCard';
import type { ToolCall } from '../types/vone';

function call(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 't1',
    name: 'vone_status',
    input: { scope: 'mission' },
    status: 'done',
    output: '{"mission":"vone-master"}',
    ...overrides,
  };
}

describe('ToolCallCard', () => {
  it('começa fechado - entrada/resultado não visíveis até o usuário clicar', () => {
    render(<ToolCallCard call={call()} />);
    expect(screen.getByText('vone_status')).toBeInTheDocument();
    expect(screen.queryByText(/mission/)).not.toBeInTheDocument();
  });

  it('expande ao clicar e mostra entrada e resultado reais, não inventados', () => {
    render(<ToolCallCard call={call()} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/"scope": "mission"/)).toBeInTheDocument();
    expect(screen.getByText(/"mission":"vone-master"/)).toBeInTheDocument();
  });

  it('clicar de novo fecha', () => {
    render(<ToolCallCard call={call()} />);
    const button = screen.getByRole('button');
    fireEvent.click(button);
    expect(screen.getByText(/"scope"/)).toBeInTheDocument();
    fireEvent.click(button);
    expect(screen.queryByText(/"scope"/)).not.toBeInTheDocument();
  });

  it('mostra o motivo do bloqueio quando status é blocked, sem fingir sucesso', () => {
    render(<ToolCallCard call={call({ status: 'blocked', output: undefined, blockReason: 'PAID_BLOCKED' })} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('PAID_BLOCKED')).toBeInTheDocument();
    expect(screen.queryByText(/resultado/)).not.toBeInTheDocument();
  });

  it('aria-expanded reflete o estado real do card', () => {
    render(<ToolCallCard call={call()} />);
    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
  });
});
