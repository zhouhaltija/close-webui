import { Children, isValidElement, memo, useEffect, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, RotateCcw } from 'lucide-react';
import type { Message } from '../core/types';
import { Mark } from './Brand';
const codeLanguages: Record<string, string> = { ts: 'typescript', typescript: 'typescript', js: 'javascript', javascript: 'javascript', json: 'json', html: 'html', css: 'css', bash: 'bash', sh: 'bash', markdown: 'markdown', md: 'markdown', go: 'go', python: 'python', yaml: 'yaml' };
function CopyButton({ text, label }: { text: string; label: string }) {
  const [result, setResult] = useState('');
  useEffect(() => { if (!result) return; const t = setTimeout(() => setResult(''), 2500); return () => clearTimeout(t); }, [result]);
  return <button className="copy-button" aria-label={label} onClick={async () => { try { await navigator.clipboard.writeText(text); setResult('已复制'); } catch { setResult('复制失败，请手动选择文本'); } }}>
    {result === '已复制' ? <Check size={14} /> : <Copy size={14} />}<span aria-live="polite">{result || (label === '复制代码' ? '复制代码' : '')}</span>
  </button>;
}
function CodeBlock({ children }: { children?: ReactNode }) {
  const child = Children.toArray(children)[0];
  const props = isValidElement<{ className?: string; children?: ReactNode }>(child) ? child.props : {};
  const code = String(props.children ?? '').replace(/\n$/, ''); const language = props.className?.replace('language-', '') || 'text';
  const [highlighted, setHighlighted] = useState<{ code: string; html: string }>();
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => { void import('./highlight').then(async shiki => { const html = await shiki.highlight(code, codeLanguages[language] || 'text'); if (!cancelled) setHighlighted({ code, html }); }).catch(() => {}); }, 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [code, language]);
  return <div className="code-block"><div className="code-heading"><span>{language}</span><CopyButton text={code} label="复制代码" /></div>{highlighted?.code === code ? <div className="highlighted" dangerouslySetInnerHTML={{ __html: highlighted.html }} /> : <pre><code>{code}</code></pre>}</div>;
}
function MessageBody({ message }: { message: Message }) {
  const waiting = message.status === 'pending' ? message.phase === 'submitting' ? '正在提交…' : message.phase === 'awaiting' ? '等待模型响应…' : '正在整理思路' : '';
  return <div className="markdown" data-phase={message.phase ?? ''} data-status={message.status}>
    <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ pre: CodeBlock, table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>, a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a> }}>{message.content}</Markdown>
    {waiting && <span className="thinking" role="status">{waiting}<span>···</span></span>}
    {message.status === 'streaming' && <span className="stream-cursor" aria-label="正在生成" />}
  </div>;
}
/** Rendered once per unchanged message: only the streaming answer re-renders on a delta. */
export const MessageView = memo(function MessageView({ message, canRetry, onRetry, canRecover, recoveryDisabled, onRecover }: { message: Message; canRetry: boolean; onRetry: () => void; canRecover?: boolean; recoveryDisabled?: boolean; onRecover?: () => void }) {
  if (message.role === 'user') return <article className="user-message" data-testid="message-user"><div>{message.content}</div></article>;
  return <article className="assistant-message" data-testid="message-assistant" data-status={message.status}>
    <div className="assistant-heading"><Mark /><span>CloseWebUI</span></div>
    <MessageBody message={message} />
    {message.status === 'stopped' && <p className="message-status">已停止生成</p>}
    {message.status === 'failed' && <div className="message-error" role="alert">{message.error?.message || '回答中断了，请重试。'}{canRecover && <> 当前显示的部分正文可能尚未保存，刷新仅恢复已保存内容。<button disabled={recoveryDisabled} onClick={onRecover}>恢复已保存内容</button></>}{canRetry && <button onClick={onRetry}><RotateCcw size={14} />重试回答</button>}</div>}
    {message.content && !['pending', 'streaming'].includes(message.status) && <div className="message-actions"><CopyButton text={message.content} label="复制回答" /></div>}
  </article>;
}, (previous, next) => previous.message === next.message && previous.canRetry === next.canRetry && previous.canRecover === next.canRecover && previous.recoveryDisabled === next.recoveryDisabled);
