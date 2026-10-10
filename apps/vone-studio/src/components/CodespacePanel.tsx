import type { Workspace } from '../types/vone';
import { FileTree } from './FileTree';
import './CodespacePanel.css';

export function CodespacePanel({ workspace, collapsed }: { workspace: Workspace | null; collapsed: boolean }) {
  return (
    <aside className={`vone-codespace ${collapsed ? 'vone-codespace--collapsed' : ''}`}>
      <div className="vone-codespace__header">
        <span>Codespace</span>
      </div>
      <div className="vone-codespace__body">
        {workspace ? (
          <FileTree root={workspace.root} />
        ) : (
          <p className="vone-codespace__empty">Nenhuma pasta aberta. Use "+ Abrir outra pasta" na barra lateral.</p>
        )}
      </div>
    </aside>
  );
}
