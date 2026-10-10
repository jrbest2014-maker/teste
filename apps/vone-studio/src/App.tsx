import { useEffect, useMemo, useState } from 'react';
import { MockVOneApiClient, type VOneApiClient } from './api/client';
import type { ChatMessage, GateStatus, Session, Workspace } from './types/vone';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { ChatPanel } from './components/ChatPanel';
import { CodespacePanel } from './components/CodespacePanel';
import './App.css';

const api: VOneApiClient = new MockVOneApiClient();

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [gates, setGates] = useState<GateStatus | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 960);
  const [codespaceOpen, setCodespaceOpen] = useState(() => window.innerWidth > 1200);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    api.listSessions().then((list) => {
      setSessions(list);
      setActiveSessionId((current) => current ?? list[0]?.id ?? null);
    });
    api.listWorkspaces().then((list) => {
      setWorkspaces(list);
      setActiveWorkspaceId((current) => current ?? list[0]?.id ?? null);
    });
    api.getGateStatus().then(setGates);
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
