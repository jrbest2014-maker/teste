import { useState } from 'react';
import type { ToolCall } from '../types/vone';
import './ToolCallCard.css';

const STATUS_ICON: Record<ToolCall['status'], string> = {
  running: '◐',
  done: '✓',
  error: '✕',
  blocked: '⊘',
};

export function ToolCallCard({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);

  return (
    <div className={`vone-tool-card vone-tool-card--${call.status}`}>
      <button
        className="vone-tool-card__header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        type="button"
      >
        <span className="vone-tool-card__icon" aria-hidden="true">
          {STATUS_ICON[call.status]}
        </span>
        <span className="vone-tool-card__name">{call.name}</span>
        <span className="vone-tool-card__status">{call.status}</span>
        <span className="vone-tool-card__chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && (
        <div className="vone-tool-card__body">
          <div className="vone-tool-card__section">
            <span className="vone-tool-card__label">entrada</span>
            <pre>{JSON.stringify(call.input, null, 2)}</pre>
          </div>
          {call.output && (
            <div className="vone-tool-card__section">
              <span className="vone-tool-card__label">resultado</span>
              <pre>{call.output}</pre>
            </div>
          )}
          {call.blockReason && (
            <div className="vone-tool-card__section">
              <span className="vone-tool-card__label">bloqueado por</span>
              <pre>{call.blockReason}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
