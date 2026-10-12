import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { ModelSelector } from './ModelSelector';
export type ComposerProps = { value: string; onChange: (value: string) => void; onSend: () => void; onStop: () => void; busy: boolean; disabled?: boolean; sendDisabled?: boolean; home?: boolean; modelSelector?: ReactNode };
export function Composer({ value, onChange, onSend, onStop, busy, disabled, sendDisabled, home, modelSelector }: ComposerProps) {
  const textarea = useRef<HTMLTextAreaElement>(null); const composing = useRef(false);
  useLayoutEffect(() => { const el = textarea.current; if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(200, Math.max(44, el.scrollHeight))}px`; } }, [value]);
  const canSend = value.trim().length > 0 && !busy && !disabled && !sendDisabled;
  return <form className={`composer ${home ? 'composer-home' : ''}`} onSubmit={e => { e.preventDefault(); if (canSend) onSend(); }}>
    <textarea ref={textarea} rows={1} aria-label="输入消息" placeholder={home ? '今天我能为您做些什么？' : '继续对话…'} value={value} onChange={e => onChange(e.target.value)} disabled={disabled}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !composing.current && e.nativeEvent.keyCode !== 229) { e.preventDefault(); if (canSend) onSend(); } }} />
    <div className="composer-toolbar">
      <div className="composer-right">
        {modelSelector ?? <ModelSelector />}
        {/* One stable button element: swapping two buttons at the same coordinates would
            let a single click both stop a generation and submit a new message. */}
        <button type="submit" className="send-button" hidden={!!home && !busy && !value.trim()} aria-label={busy ? '停止生成' : '发送消息'} title={busy ? '停止生成' : '发送消息'} onClick={e => { if (busy) { e.preventDefault(); onStop(); } }} disabled={!busy && !canSend}>{busy ? <Square size={15} fill="currentColor" /> : <ArrowUp size={18} strokeWidth={1.8} />}</button>
      </div>
    </div>
  </form>;
}
