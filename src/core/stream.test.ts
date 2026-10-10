import { describe, expect, it } from 'vitest';
import { readEvents } from './stream';
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
});
