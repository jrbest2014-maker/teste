import type { ChatMessage } from '../types/vone';
import { RouteStatusBadge } from './StatusBadge';
import { ToolCallCard } from './ToolCallCard';
import './MessageBubble.css';

export function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  const time = new Date(message.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  return (
    <div className={`vone-message vone-message--${message.role}`}>
      <div className="vone-message__meta">
        <span className="vone-message__author">{isUser ? 'Você' : 'V-ONE'}</span>
        <span className="vone-message__time">{time}</span>
        {message.route && <RouteStatusBadge route={message.route} />}
      </div>
      <div className="vone-message__bubble">
        <p className="vone-message__text">{message.text}</p>
        {message.toolCalls?.map((call) => <ToolCallCard key={call.id} call={call} />)}
      </div>
    </div>
  );
}
