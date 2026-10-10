import type { GenerationEvent } from './types';
export async function* readEvents(body: ReadableStream<Uint8Array>, id: string, signal?: AbortSignal): AsyncGenerator<GenerationEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  const aborted = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', aborted, { once: true });
  const parse = (line: string): GenerationEvent => {
    const event = JSON.parse(line) as GenerationEvent;
    if (!event || event.assistantMessageId !== id || !['delta', 'done', 'error'].includes(event.type) ||
      (event.type === 'delta' && typeof event.content !== 'string') ||
      (event.type === 'error' && (typeof event.code !== 'string' || typeof event.message !== 'string'))) throw new Error('回答事件格式无效，请重试。');
    return event;
  };
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      buffer += decoder.decode(value, { stream: !done });
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
