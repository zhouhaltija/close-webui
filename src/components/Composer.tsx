import { useLayoutEffect, useRef } from 'react';
import { ArrowUp, Square } from 'lucide-react';
export type ComposerProps = { value: string; onChange: (value: string) => void; onSend: () => void; onStop: () => void; busy: boolean; disabled?: boolean; home?: boolean };
export function Composer({ value, onChange, onSend, onStop, busy, disabled, home }: ComposerProps) {
  const textarea = useRef<HTMLTextAreaElement>(null); const composing = useRef(false);
  useLayoutEffect(() => { const el = textarea.current; if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(200, Math.max(56, el.scrollHeight))}px`; } }, [value]);
  const canSend = value.trim().length > 0 && !busy && !disabled;
  return <form className={`composer ${home ? 'composer-home' : ''}`} onSubmit={e => { e.preventDefault(); if (canSend) onSend(); }}>
    <textarea ref={textarea} aria-label="输入消息" placeholder={home ? '有什么想法？从这里开始…' : '继续对话…'} value={value} onChange={e => onChange(e.target.value)} disabled={disabled}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !composing.current && e.nativeEvent.keyCode !== 229) { e.preventDefault(); if (canSend) onSend(); } }} />
    <div className="composer-toolbar"><span>把想法说出来，让思路更清晰</span>
      {busy ? <button type="button" className="send-button" aria-label="停止生成" title="停止生成" onClick={onStop}><Square size={17} fill="currentColor" /></button> : <button type="submit" className="send-button" aria-label="发送消息" title="发送消息" disabled={!canSend}><ArrowUp size={21} strokeWidth={2.2} /></button>}
    </div>
  </form>;
}
