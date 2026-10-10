import { http, HttpResponse } from 'msw';
import type { Repository } from './repository';
import { ApiError } from '../core/errors';
import type { GenerationInput, GenerationEvent } from '../core/types';
import { answer } from './fixture';
export type Scenario = 'normal' | 'slow' | 'failure';
export function createMockService(repo: Repository, scenario: () => Scenario = () => 'normal') {
  const active = new Map<string, AbortController>();
  const failure = (error: unknown) => { const e = error instanceof ApiError ? error : new ApiError('INVALID_REQUEST', '请求数据无效。'); return HttpResponse.json({ error: { code: e.code, message: e.message } }, { status: e.status }); };
  const handlers = [
    http.get('*/api/conversations', () => HttpResponse.json(repo.list())),
    http.post('*/api/conversations', async ({ request }) => { try { const body = await request.json() as { title: string }; return HttpResponse.json(repo.create(body.title), { status: 201 }); } catch (e) { return failure(e); } }),
    http.get('*/api/conversations/:id', ({ params }) => { try { return HttpResponse.json(repo.get(String(params.id))); } catch (e) { return failure(e); } }),
    http.patch('*/api/conversations/:id', async ({ request, params }) => { try { const body = await request.json() as { title: string }; return HttpResponse.json(repo.rename(String(params.id), body.title)); } catch (e) { return failure(e); } }),
    http.delete('*/api/conversations/:id', ({ params }) => { try { const id = String(params.id); active.get(id)?.abort(); active.delete(id); repo.remove(id); return new HttpResponse(null, { status: 204 }); } catch (e) { return failure(e); } }),
    http.post('*/api/conversations/:id/generations', async ({ request, params }) => {
      const id = String(params.id);
      try {
        const input = await request.json() as GenerationInput;
        if (request.signal.aborted) return new HttpResponse(null, { status: 499 });
        repo.begin(id, input);
        const control = new AbortController(); active.set(id, control);
        const selected = scenario(); const characters = Array.from(answer); const size = selected === 'slow' ? 12 : 24; const pause = selected === 'slow' ? 300 : 60;
        const delay = (ms: number) => new Promise<void>((resolve, reject) => {
          if (control.signal.aborted) { reject(control.signal.reason); return; }
          const abort = () => { clearTimeout(timer); reject(control.signal.reason); };
          const timer = setTimeout(() => { control.signal.removeEventListener('abort', abort); resolve(); }, ms);
          control.signal.addEventListener('abort', abort, { once: true });
        });
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const emit = (event: GenerationEvent) => controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n'));
            void (async () => {
              try {
                await delay(selected === 'slow' ? 1500 : 300);
                for (let offset = 0, count = 0; offset < characters.length; offset += size, count++) {
                  if (control.signal.aborted || active.get(id) !== control) return;
                  const content = characters.slice(offset, offset + size).join(''); repo.delta(id, input.assistantMessageId, content); emit({ type: 'delta', assistantMessageId: input.assistantMessageId, content });
                  if (selected === 'failure' && !input.retry && count === 2) {
                    const error = { code: 'MOCK_FAILURE', message: '回答暂时中断了，请重试。' }; repo.finish(id, input.assistantMessageId, 'failed', error); emit({ type: 'error', assistantMessageId: input.assistantMessageId, ...error }); return;
                  }
                  await delay(pause);
                }
                if (!control.signal.aborted) { repo.finish(id, input.assistantMessageId, 'completed'); emit({ type: 'done', assistantMessageId: input.assistantMessageId }); }
              } catch { if (control.signal.aborted) repo.finish(id, input.assistantMessageId, 'stopped'); }
              finally { if (active.get(id) === control) active.delete(id); try { controller.close(); } catch { /* Already cancelled by the consumer. */ } }
            })();
          },
          cancel() { control.abort(); repo.finish(id, input.assistantMessageId, 'stopped'); },
        });
        return new HttpResponse(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
      } catch (e) { return failure(e); }
    }),
  ];
  return { handlers, terminate(id: string, messageId: string, status: 'stopped' | 'failed', error?: { code: string; message: string }) { active.get(id)?.abort(); active.delete(id); repo.finish(id, messageId, status, error); try { return repo.get(id); } catch { return undefined; } } };
}
export const createHandlers = (repo: Repository) => createMockService(repo).handlers;
