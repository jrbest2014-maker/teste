import type { Session, Workspace } from '../types/vone';
import './Sidebar.css';

export function Sidebar({
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  collapsed,
}: {
  workspaces: readonly Workspace[];
  activeWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  sessions: readonly Session[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  collapsed: boolean;
}) {
  return (
    <aside className={`vone-sidebar ${collapsed ? 'vone-sidebar--collapsed' : ''}`}>
      <div className="vone-sidebar__section">
        <div className="vone-sidebar__label">
          <span>Codespace</span>
        </div>
        <select
          className="vone-sidebar__select"
          value={activeWorkspaceId ?? ''}
          onChange={(event) => onSelectWorkspace(event.target.value)}
        >
          {workspaces.length === 0 && <option value="">Nenhuma pasta aberta</option>}
          {workspaces.map((ws) => (
            <option key={ws.id} value={ws.id}>
              {ws.name}
            </option>
          ))}
        </select>
        <button className="vone-sidebar__add-folder" type="button">
          + Abrir outra pasta
        </button>
      </div>

      <div className="vone-sidebar__section vone-sidebar__section--grow">
        <div className="vone-sidebar__label">
          <span>Conversas</span>
          <button className="vone-sidebar__new" onClick={onNewSession} type="button" title="Nova conversa">
            +
          </button>
        </div>
        <ul className="vone-sidebar__sessions">
          {sessions.map((session) => (
            <li key={session.id}>
              <button
                className={`vone-sidebar__session ${session.id === activeSessionId ? 'is-active' : ''}`}
                onClick={() => onSelectSession(session.id)}
                type="button"
              >
                <span className="vone-sidebar__session-title">{session.title}</span>
                <span className="vone-sidebar__session-time">
                  {new Date(session.updatedAt).toLocaleDateString('pt-BR')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
