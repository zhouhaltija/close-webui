import type { ChatApi } from './api';
import type { Conversation, GenerationInput } from './types';
import { errorText } from './errors';
import { readEvents } from './stream';
export type GenerationDependencies = { api: ChatApi; publish: (c: Conversation) => void; busy: (value: boolean) => void; accepted: (id: string) => void; error: (message: string) => void; navigate: (id: string) => void; terminate?: (id: string, messageId: string, status: 'stopped' | 'failed', error?: { code: string; message: string }) => Conversation | undefined };
export class GenerationCoordinator {
  private active?: { controller: AbortController; id?: string; input: GenerationInput; conversation?: Conversation; accepted: boolean };
  constructor(private deps: GenerationDependencies) {}
  get isActive() { return this.active !== undefined; }
  get conversationId(): string | undefined { return this.active?.id; }
  async send(content: string, id?: string, retry?: GenerationInput): Promise<boolean> {
    if (this.active || !content.trim()) return false;
    const active = { controller: new AbortController(), id, input: retry ?? { content, userMessageId: crypto.randomUUID(), assistantMessageId: crypto.randomUUID(), retry: false }, conversation: undefined as Conversation | undefined, accepted: false };
    this.active = active; this.deps.busy(true); this.deps.error('');
    const current = () => this.active === active && !active.controller.signal.aborted;
    const publish = () => { if (active.conversation) this.deps.publish(structuredClone(active.conversation)); };
    try {
      if (!id) {
        const line = content.trim().split('\n')[0].replace(/\s+/g, ' '); const chars = Array.from(line); const title = chars.slice(0, 24).join('') + (chars.length > 24 ? '…' : '');
        const c = await this.deps.api.create(title, active.controller.signal);
        if (!current()) return false;
        active.id = c.id; active.conversation = c; publish(); this.deps.navigate(c.id);
      } else { active.conversation = await this.deps.api.get(id); }
      if (!current()) return false;
      const response = await this.deps.api.generate(active.id!, active.input, active.controller.signal);
      if (!current()) return false;
      active.accepted = true;
      const c = active.conversation!; const now = new Date().toISOString();
      if (active.input.retry) { const m = c.messages.find(m => m.id === active.input.assistantMessageId)!; m.content = ''; m.status = 'pending'; delete m.error; }
      else {
        c.messages.push({ id: active.input.userMessageId, conversationId: c.id, role: 'user', content: active.input.content, status: 'completed', createdAt: now }, { id: active.input.assistantMessageId, conversationId: c.id, role: 'assistant', content: '', status: 'pending', createdAt: now }); c.updatedAt = now;
      }
      this.deps.accepted(c.id); publish();
      if (!response.body) throw new Error('没有收到回答内容，请重试。');
      for await (const event of readEvents(response.body, active.input.assistantMessageId, active.controller.signal)) {
        if (!current()) break;
        const m = c.messages.find(m => m.id === active.input.assistantMessageId)!;
        if (event.type === 'delta') { m.content += event.content; m.status = 'streaming'; }
        else if (event.type === 'done') m.status = 'completed';
        else { m.status = 'failed'; m.error = { code: event.code, message: event.message }; }
        publish();
      }
      return true;
    } catch (error) {
      if (!current()) return false;
      const message = errorText(error);
      if (active.accepted && active.conversation) {
        const m = active.conversation.messages.find(m => m.id === active.input.assistantMessageId)!;
        m.status = 'failed'; m.error = { code: 'STREAM_FAILED', message }; publish();
        this.deps.terminate?.(active.id!, m.id, 'failed', m.error);
      } else this.deps.error(message);
      return false;
    } finally {
      if (this.active === active) { this.active = undefined; this.deps.busy(false); }
    }
  }
  stop() {
    const active = this.active; if (!active) return;
    this.active = undefined; active.controller.abort();
    const snapshot = active.id ? this.deps.terminate?.(active.id, active.input.assistantMessageId, 'stopped') : undefined;
    if (snapshot) this.deps.publish(snapshot);
    else if (active.accepted && active.conversation) { const m = active.conversation.messages.find(m => m.id === active.input.assistantMessageId); if (m && ['pending', 'streaming'].includes(m.status)) m.status = 'stopped'; this.deps.publish(structuredClone(active.conversation)); }
    this.deps.busy(false);
  }
}
