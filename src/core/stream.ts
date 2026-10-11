import type { GenerationEvent } from './types';
export async function* readEvents(body: ReadableStream<Uint8Array>, id: string, signal?: AbortSignal): AsyncGenerator<GenerationEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  const aborted = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', aborted, { once: true });
  const parse = (line: string): GenerationEvent => {
    let event: GenerationEvent;
    try { event = JSON.parse(line) as GenerationEvent; }
    catch { throw new Error('回答事件格式无效，请重试。'); }
    if (!event || event.assistantMessageId !== id || !['delta', 'done', 'error'].includes(event.type) ||
      (event.type === 'delta' && typeof event.content !== 'string') ||
      (event.type === 'error' && (typeof event.code !== 'string' || typeof event.message !== 'string'))) throw new Error('回答事件格式无效，请重试。');
    return event;
  };
  try {
    while (true) {
      signal?.throwIfAborted();
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); }
      catch { signal?.throwIfAborted(); throw new Error('回答连接中断，请重试。'); }
      const { value, done } = chunk;
      signal?.throwIfAborted();
      try { buffer += decoder.decode(value, { stream: !done }); }
      catch { throw new Error('回答编码无效，请重试。'); }
      let boundary: number;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary).trim(); buffer = buffer.slice(boundary + 1);
        if (!line) continue;
        const event = parse(line); yield event;
        if (event.type !== 'delta') return;
      }
      if (done) {
        if (buffer.trim()) { const event = parse(buffer.trim()); yield event; if (event.type !== 'delta') return; }
        throw new Error('回答意外中断，请重试。');
      }
    }
  } finally {
    signal?.removeEventListener('abort', aborted);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}
