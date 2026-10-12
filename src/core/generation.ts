import type { ChatApi } from './api';
import type { Conversation, GenerationInput, Message, SubmissionPhase, SubmissionPreview } from './types';
import { errorText } from './errors';
import { readEvents } from './stream';

export type { SubmissionPreview };
export type GenerationDependencies = {
  api: ChatApi;
  publish: (c: Conversation) => void;
  preview: (state: SubmissionPreview | undefined) => void;
  busy: (value: boolean) => void;
  accepted: (id: string) => void;
  error: (message: string) => void;
  navigate: (id: string) => void;
  /** Returns an already loaded conversation so an existing chat does not need another GET. */
  load?: (id: string) => Conversation | undefined;
  terminate?: (id: string, messageId: string, status: 'stopped' | 'failed', error?: { code: string; message: string }) => Conversation | undefined;
};

type Active = { controller: AbortController; id?: string; input: GenerationInput; title: string; conversation?: Conversation; accepted: boolean; phase: SubmissionPhase; preview?: Message[] };

const frame = (): number | undefined => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => {}) : undefined);
void frame;
function nextTick(run: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(run);
  return setTimeout(run, 16) as unknown as number;
}
function cancelTick(handle: number | undefined) {
  if (handle === undefined) return;
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
  else clearTimeout(handle);
}

export class GenerationCoordinator {
  private active?: Active;
  private handle?: number;
  constructor(private deps: GenerationDependencies) {}
  get isActive() { return this.active !== undefined; }
  get conversationId(): string | undefined { return this.active?.id; }
  async send(content: string, id?: string, retry?: GenerationInput, selection?: Pick<GenerationInput, 'modelId' | 'reasoning'>): Promise<boolean> {
    if (this.active || !content.trim()) return false;
    const input: GenerationInput = structuredClone(retry ?? { content, userMessageId: crypto.randomUUID(), assistantMessageId: crypto.randomUUID(), retry: false, ...selection });
    if (selection || input.modelId) input.generationId = crypto.randomUUID();
    const now = new Date().toISOString();
    const line = content.trim().split('\n')[0].replace(/\s+/g, ' '); const chars = Array.from(line); const title = chars.slice(0, 24).join('') + (chars.length > 24 ? '…' : '');
    const preview: Message[] | undefined = retry ? undefined : [
      { id: input.userMessageId, conversationId: id ?? '', role: 'user', content: input.content, status: 'completed', createdAt: now },
      { id: input.assistantMessageId, conversationId: id ?? '', role: 'assistant', content: '', status: 'pending', createdAt: now, phase: 'submitting', ...(input.modelId ? { modelId: input.modelId, generationId: input.generationId, reasoning: input.reasoning } : {}) },
    ];
    const active: Active = { controller: new AbortController(), id, input, title, accepted: false, phase: 'submitting', preview };
    this.active = active; this.deps.busy(true); this.deps.error('');
    const current = () => this.active === active && !active.controller.signal.aborted;
    const showPreview = () => { if (active.preview) this.deps.preview({ conversationId: active.id, title: active.title, phase: active.phase, messages: active.preview }); };
    const hidePreview = () => { this.deps.preview(undefined); };
    const publish = () => { if (active.conversation) this.deps.publish(active.conversation); };
    // Streaming snapshots arrive far faster than a frame; coalesce them so the browser
    // renders once per frame and unchanged messages keep their object identity.
    const schedule = () => { if (this.handle === undefined) this.handle = nextTick(() => { this.handle = undefined; if (this.active === active) publish(); }); };
    const flushFrames = () => { cancelTick(this.handle); this.handle = undefined; publish(); };
    const withConversation = (conversation: Conversation) => { active.conversation = conversation; };
    const replaceAssistant = (update: (message: Message) => Message) => {
      const conversation = active.conversation; if (!conversation) return;
      const index = conversation.messages.findIndex(message => message.id === active.input.assistantMessageId);
      if (index < 0) return;
      const messages = conversation.messages.slice();
      messages[index] = update(messages[index]);
      active.conversation = { ...conversation, messages };
    };
    const touch = () => { if (active.conversation) active.conversation = { ...active.conversation, updatedAt: new Date().toISOString() }; };
    try {
      if (!id) {
        showPreview();
        const created = await this.deps.api.create(title, active.controller.signal);
        if (!current()) return false;
        active.id = created.id;
        const messages = [...created.messages, ...(active.preview || []).map(message => ({ ...message, conversationId: created.id }))];
        withConversation({ ...created, messages }); touch(); active.phase = 'awaiting';
        showPreview(); publish(); this.deps.navigate(created.id);
      } else {
        withConversation(this.deps.load?.(id) ?? await this.deps.api.get(id));
        if (!current()) return false;
        if (active.preview) {
          const messages = [...active.conversation!.messages, ...active.preview.map(message => ({ ...message, conversationId: active.conversation!.id }))];
          withConversation({ ...active.conversation!, messages }); active.phase = 'submitting';
        }
        showPreview(); publish();
      }
      if (!current()) return false;
      const response = await this.deps.api.generate(active.id!, active.input, active.controller.signal);
      if (!current()) return false;
      active.accepted = true; active.phase = 'awaiting';
      if (active.input.retry) replaceAssistant(message => ({ ...message, content: '', status: 'pending', generationId: active.input.generationId, phase: 'awaiting', error: undefined }));
      else replaceAssistant(message => ({ ...message, phase: 'awaiting' }));
      showPreview();
      this.deps.accepted(active.id!); publish();
      if (!response.body) throw new Error('没有收到回答内容，请重试。');
      for await (const event of readEvents(response.body, active.input.assistantMessageId, active.controller.signal)) {
        if (!current()) break;
        if (event.type === 'delta') {
          if (active.conversation?.messages.some(message => message.id === event.assistantMessageId && message.status === 'pending')) touch();
          replaceAssistant(message => ({ ...message, content: message.content + event.content, status: 'streaming', phase: undefined }));
        } else if (event.type === 'done') replaceAssistant(message => ({ ...message, status: 'completed', phase: undefined }));
        else replaceAssistant(message => ({ ...message, status: 'failed', phase: undefined, error: { code: event.code, message: event.message } }));
        schedule();
      }
      flushFrames(); hidePreview();
      return true;
    } catch (error) {
      if (!current()) return false;
      const message = errorText(error);
      if (active.accepted && active.conversation) {
        replaceAssistant(m => ({ ...m, status: 'failed', phase: undefined, error: { code: 'STREAM_FAILED', message } }));
        flushFrames(); hidePreview();
        this.deps.terminate?.(active.id!, active.input.assistantMessageId, 'failed', { code: 'STREAM_FAILED', message });
      } else if (active.id && active.conversation) {
        // The submission outcome is unknown: reconcile by the original message IDs
        // instead of blindly creating a second user message or a plain retry.
        let settled = false;
        try {
          const fresh = await this.deps.api.get(active.id);
          if (!current()) return false;
          const user = fresh.messages.find(m => m.id === active.input.userMessageId);
          const assistant = fresh.messages.find(m => m.id === active.input.assistantMessageId);
          if (user && assistant) {
            withConversation(fresh); settled = true; this.deps.accepted(active.id!);
            if (assistant.status === 'failed') this.deps.terminate?.(active.id!, assistant.id, 'failed', assistant.error);
          }
        } catch { /* Reconciliation is best effort; fall through to the local failure. */ }
        if (!current()) return false;
        if (settled) { flushFrames(); hidePreview(); }
        else {
          if (active.preview) { active.preview = active.preview.map(m => m.id === active.input.assistantMessageId ? { ...m, status: 'failed', error: { code: 'SUBMIT_FAILED', message } } : m); showPreview(); }
          this.deps.error(message);
        }
      } else {
        // Creation failed before any server conversation or message was accepted.
        // Keep the composer draft, but remove temporary messages and their retry UI.
        hidePreview();
        this.deps.error(message);
      }
      return false;
    } finally {
      if (this.active === active) { cancelTick(this.handle); this.handle = undefined; this.active = undefined; this.deps.busy(false); }
    }
  }
  stop() {
    const active = this.active; if (!active) return;
    this.active = undefined; active.controller.abort();
    cancelTick(this.handle); this.handle = undefined;
    if (active.id && active.input.generationId) void this.deps.api.stop?.(active.id, active.input.generationId).catch(error => this.deps.error(errorText(error)));
    const snapshot = active.id ? this.deps.terminate?.(active.id, active.input.assistantMessageId, 'stopped') : undefined;
    if (snapshot) this.deps.publish(snapshot);
    else if (active.conversation) {
      const index = active.conversation.messages.findIndex(message => message.id === active.input.assistantMessageId);
      if (index >= 0 && ['pending', 'streaming'].includes(active.conversation.messages[index].status)) {
        const messages = active.conversation.messages.slice();
        messages[index] = { ...messages[index], status: 'stopped', phase: undefined };
        this.deps.publish({ ...active.conversation, messages });
      }
    }
    this.deps.preview(undefined);
    this.deps.busy(false);
  }
}
