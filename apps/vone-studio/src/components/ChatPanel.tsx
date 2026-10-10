import { useEffect, useRef } from 'react';
import type { ChatMessage } from '../types/vone';
import { MessageBubble } from './MessageBubble';
import { Composer } from './Composer';
import './ChatPanel.css';

export function ChatPanel({
  messages,
  onSend,
  sending,
}: {
  messages: readonly ChatMessage[];
  onSend: (text: string) => void;
  sending: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length]);

  return (
    <section className="vone-chat-panel">
      <div className="vone-chat-panel__scroll" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="vone-chat-panel__empty">
            <p>Nenhuma mensagem ainda. Escreva algo abaixo para começar.</p>
          </div>
        ) : (
          messages.map((message) => <MessageBubble key={message.id} message={message} />)
        )}
        {sending && <div className="vone-chat-panel__typing">V-ONE está pensando…</div>}
      </div>
      <Composer onSend={onSend} disabled={sending} />
    </section>
  );
}
