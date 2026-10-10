import { useState, type KeyboardEvent } from 'react';
import './Composer.css';

export function Composer({ onSend, disabled }: { onSend: (text: string) => void; disabled?: boolean }) {
  const [value, setValue] = useState('');

  const submit = () => {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="vone-composer">
      <textarea
        className="vone-composer__input"
        placeholder="Peça algo ao V-ONE... (Enter envia, Shift+Enter quebra linha)"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        disabled={disabled}
      />
      <button className="vone-composer__send" onClick={submit} disabled={disabled || !value.trim()} type="button">
        Enviar
      </button>
    </div>
  );
}
