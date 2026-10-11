import { describe, expect, it } from 'vitest';
import { readEvents } from './stream';
import type { GenerationEvent } from './types';
const encoder = new TextEncoder();
const source = (chunks: Uint8Array[]) => new ReadableStream<Uint8Array>({ start(c) { chunks.forEach(chunk => c.enqueue(chunk)); c.close(); } });
const collect = async (s: ReadableStream<Uint8Array>, signal?: AbortSignal) => { const events = []; for await (const event of readEvents(s, 'a', signal)) events.push(event); return events; };
describe('NDJSON protocol', () => {
  it('decodes split UTF-8, multiple events and a final line without newline', async () => {
    const data = encoder.encode('{"type":"delta","assistantMessageId":"a","content":"你好"}\n\n{"type":"done","assistantMessageId":"a"}');
    const split = data.findIndex(n => n > 127) + 1;
    expect(await collect(source([data.slice(0, split), data.slice(split)]))).toEqual([{ type: 'delta', assistantMessageId: 'a', content: '你好' }, { type: 'done', assistantMessageId: 'a' }]);
  });
  it.each(['{"type":"delta","assistantMessageId":"a","content":"x"}', '{"type":"done","assistantMessageId":"other"}', '{"type":"unknown","assistantMessageId":"a"}', '{broken'])('rejects incomplete or invalid protocol: %s', async text => {
    await expect(collect(source([encoder.encode(text)]))).rejects.toThrow();
  });
  it('does not consume content after terminal event', async () => {
    const data = '{"type":"done","assistantMessageId":"a"}\n{broken';
    expect(await collect(source([encoder.encode(data)]))).toEqual([{ type: 'done', assistantMessageId: 'a' }]);
  });
  it('honors an already aborted request', async () => {
    const c = new AbortController(); c.abort();
    await expect(collect(source([]), c.signal)).rejects.toThrow();
  });
  it('describes malformed JSON in Chinese rather than exposing the parser error', async () => {
    await expect(collect(source([encoder.encode('{broken\n')]))).rejects.toThrow('回答事件格式无效，请重试。');
  });
  it('describes corrupt UTF-8 in Chinese', async () => {
    await expect(collect(source([new Uint8Array([0xff])]))).rejects.toThrow('回答编码无效，请重试。');
  });
  it('retains partial deltas and describes a broken connection in Chinese', async () => {
    let emitted = false;
    const broken = new ReadableStream<Uint8Array>({ pull(controller) {
      if (emitted) controller.error(new TypeError('network error'));
      else { emitted = true; controller.enqueue(encoder.encode('{"type":"delta","assistantMessageId":"a","content":"部分回答"}\n')); }
    } });
    const events: GenerationEvent[] = [];
    const read = async () => { for await (const event of readEvents(broken, 'a')) events.push(event); };
    await expect(read()).rejects.toThrow('回答连接中断，请重试。');
    expect(events).toEqual([{ type: 'delta', assistantMessageId: 'a', content: '部分回答' }]);
  });
});
