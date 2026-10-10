import { useEffect, useMemo, useState } from 'react';
import { HttpVOneApiClient, MockVOneApiClient, type VOneApiClient } from './api/client';
import { getOrCreateDeviceId } from './api/deviceId';
import type { ChatMessage, GateStatus, Session, Workspace } from './types/vone';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { ChatPanel } from './components/ChatPanel';
import { CodespacePanel } from './components/CodespacePanel';
import './App.css';

const masterUrl = import.meta.env.VITE_VONE_MASTER_URL as string | undefined;
const cloudWorkerUrl = import.meta.env.VITE_VONE_CLOUD_WORKER_URL as string | undefined;
const usingLiveBackend = Boolean(masterUrl || cloudWorkerUrl);

// Sem nenhuma VITE_VONE_* configurada, fica no mock (navegável, sem rede).
// Com qualquer uma configurada, fala com o backend real - ver
// src/api/client.ts pro que está confirmado vs. inferido em cada chamada.
const api: VOneApiClient = usingLiveBackend
  ? new HttpVOneApiClient({ masterUrl, cloudWorkerUrl, deviceId: getOrCreateDeviceId() })
  : new MockVOneApiClient();

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [gates, setGates] = useState<GateStatus | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 960);
  const [codespaceOpen, setCodespaceOpen] = useState(() => window.innerWidth > 1200);
  const [sending, setSending] = useState(false);
  const [backendError, setBackendError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listSessions()
      .then((list) => {
        setSessions(list);
        setActiveSessionId((current) => current ?? list[0]?.id ?? null);
      })
      .catch((error: unknown) => setBackendError(`histórico: ${(error as Error).message}`));
    api.listWorkspaces().then((list) => {
      setWorkspaces(list);
      setActiveWorkspaceId((current) => current ?? list[0]?.id ?? null);
    });
    api
      .getGateStatus()
      .then(setGates)
      .catch((error: unknown) => setBackendError((prev) => prev ?? `gates: ${(error as Error).message}`));
  }, []);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );
  const activeWorkspace = useMemo(
    () => workspaces.find((ws) => ws.id === activeWorkspaceId) ?? null,
    [workspaces, activeWorkspaceId],
  );
  const lastRoute = useMemo(() => {
    const messages = activeSession?.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].route) return messages[i].route ?? null;
    }
    return null;
  }, [activeSession]);

  const handleSend = async (text: string) => {
    if (!activeSession) return;
    const userMessage: ChatMessage = {
      id: `local-${Date.now()}`,
      role: 'user',
      text,
      createdAt: new Date().toISOString(),
    };
    setSessions((prev) =>
      prev.map((s) => (s.id === activeSession.id ? { ...s, messages: [...s.messages, userMessage] } : s)),
    );
    setSending(true);
    try {
      const reply = await api.sendMessage(activeSession.id, text);
      setSessions((prev) =>
        prev.map((s) => (s.id === activeSession.id ? { ...s, messages: [...s.messages, reply] } : s)),
      );
    } catch (error) {
      setBackendError(`envio: ${(error as Error).message}`);
    } finally {
      setSending(false);
    }
  };

  const handleNewSession = () => {
    const session: Session = {
      id: `local-session-${Date.now()}`,
      title: 'Nova conversa',
      updatedAt: new Date().toISOString(),
      messages: [],
    };
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
  };

  return (
    <div className="vone-app">
      <TopBar
        onToggleSidebar={() =>
          setSidebarOpen((v) => {
            const next = !v;
            if (next && window.innerWidth <= 960) setCodespaceOpen(false);
            return next;
          })
        }
        onToggleCodespace={() =>
          setCodespaceOpen((v) => {
            const next = !v;
            if (next && window.innerWidth <= 1200) setSidebarOpen(false);
            return next;
          })
        }
        route={lastRoute}
        gates={gates ?? { paidBlocked: 'INVIOLABLE', unknownCost: 'HOLD', physicalOutput: 'LOCKED' }}
      />
      {backendError && (
        <div className="vone-backend-error" role="alert">
          Backend real falhou ({backendError}) - sem fallback silencioso pro mock.
          <button type="button" onClick={() => setBackendError(null)}>
            ok
          </button>
        </div>
      )}
      <div className="vone-app__body">
        <Sidebar
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          onSelectWorkspace={setActiveWorkspaceId}
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelectSession={setActiveSessionId}
          onNewSession={handleNewSession}
          collapsed={!sidebarOpen}
        />
        <ChatPanel messages={activeSession?.messages ?? []} onSend={handleSend} sending={sending} />
        <CodespacePanel workspace={activeWorkspace} collapsed={!codespaceOpen} />
      </div>
    </div>
  );
}
