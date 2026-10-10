import type { GateStatus, RouteBadge } from '../types/vone';
import { GateChips, RouteStatusBadge } from './StatusBadge';
import './TopBar.css';

export function TopBar({
  onToggleSidebar,
  onToggleCodespace,
  route,
  gates,
}: {
  onToggleSidebar: () => void;
  onToggleCodespace: () => void;
  route: RouteBadge | null;
  gates: GateStatus;
}) {
  return (
    <header className="vone-topbar">
      <button className="vone-topbar__icon-btn" onClick={onToggleSidebar} type="button" aria-label="Alternar menu">
        ☰
      </button>
      <div className="vone-topbar__brand">
        <img src="/icon.svg" alt="" width={22} height={22} />
        <span>V-ONE Studio</span>
      </div>
      <div className="vone-topbar__status">
        {route && <RouteStatusBadge route={route} />}
        <div className="vone-topbar__gates">
          <GateChips gates={gates} />
        </div>
      </div>
      <button
        className="vone-topbar__icon-btn"
        onClick={onToggleCodespace}
        type="button"
        aria-label="Alternar painel de arquivos"
      >
        🗂
      </button>
    </header>
  );
}
