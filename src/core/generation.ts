import type { ChatApi } from './api';
import type { Conversation, GenerationInput, Message, SubmissionPhase, SubmissionPreview } from './types';
import { ApiError, errorText } from './errors';
import { readEvents } from './stream';

export type { SubmissionPreview };
export type GenerationDependencies = {
  api: ChatApi;
  publish: (c: Conversation) => void;
  preview: (state: SubmissionPreview | undefined) => void;
  busy: (value: boolean) => void;
  accepted: (id: string, input: GenerationInput) => void;
  error: (message: string) => void;
  navigate: (id: string) => void;
  /** Returns an already loaded conversation so an existing chat does not need another GET. */
  load?: (id: string) => Conversation | undefined;
  terminate?: (id: string, messageId: string, status: 'stopped' | 'failed', error?: { code: string; message: string }) => Conversation | undefined;
};

type Active = { controller: AbortController; id?: string; input: GenerationInput; title: string; conversation?: Conversation; authoritative?: Conversation; accepted: boolean; phase: SubmissionPhase; preview?: Message[] };
type SnapshotRead = { id: string; latest?: Conversation };

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
  private uncertain?: Active;
  private unsaved = new Map<string, Active>();
  private recovering?: { active: Active };
  private reads = new Map<(snapshot: Conversation) => Conversation, SnapshotRead>();
  private handle?: number;
  constructor(private deps: GenerationDependencies) {}
  get isActive() { return this.active !== undefined || this.recovering !== undefined; }
  get hasUncertainSubmission() { return this.uncertain !== undefined; }
  get conversationId(): string | undefined { return this.active?.id ?? this.recovering?.active.id ?? this.uncertain?.id; }
  hasSaveFailure(id?: string) { return !!id && this.unsaved.has(id); }
  hasLiveView(id?: string) { return !!id && !!((this.active?.id === id && this.active.conversation) || this.unsaved.get(id)?.conversation); }
  private publish(conversation: Conversation) {
    for (const read of this.reads.values()) if (read.id === conversation.id) read.latest = conversation;
    this.deps.publish(conversation);
  }
  private withLiveMessages(snapshot: Conversation, live: Conversation): Conversation {
    return { ...snapshot, messages: live.messages, updatedAt: live.updatedAt > snapshot.updatedAt ? live.updatedAt : snapshot.updatedAt };
  }
  /** Reads overtaken by local progress cannot roll back a later completion or stop. */
  captureSnapshot(id: string): (snapshot: Conversation) => Conversation {
    const read: SnapshotRead = { id };
    const reconcile = (snapshot: Conversation) => {
      if (read.latest) return this.withLiveMessages(snapshot, read.latest);
      return this.preserveLive(snapshot);
    };
    this.reads.set(reconcile, read);
    return reconcile;
  }
  releaseSnapshot(reconcile: (snapshot: Conversation) => Conversation) {
    const read = this.reads.get(reconcile);
    if (read) read.latest = undefined;
    this.reads.delete(reconcile);
  }
  /** A database read may lag the live stream. It must not replace its local message pair. */
  preserveLive(snapshot: Conversation): Conversation {
    const live = this.active?.id === snapshot.id ? this.active : this.unsaved.get(snapshot.id);
    if (!live?.conversation) return snapshot;
    return this.withLiveMessages(snapshot, live.conversation);
  }
  async recoverSaved(id: string): Promise<boolean> {
    const unsaved = this.unsaved.get(id);
    if (!unsaved || this.active || this.recovering) return false;
    const recovery = { active: unsaved };
    this.recovering = recovery; this.deps.busy(true); this.deps.error('');
    const current = () => this.recovering === recovery && this.unsaved.get(id) === unsaved;
    try {
      if (unsaved.input.generationId && this.deps.api.stop) {
        await this.deps.api.stop(id, unsaved.input.generationId);
        if (!current()) return false;
      }
      const snapshot = await this.deps.api.get(id);
      if (!current()) return false;
      this.unsaved.delete(id); this.publish(snapshot);
      return true;
    } catch (error) {
      if (current()) this.deps.error(`无法恢复已保存内容：${errorText(error)}当前显示的正文已保留。`);
      return false;
    } finally { if (this.recovering === recovery) { this.recovering = undefined; this.deps.busy(false); } }
  }
  private async reconcileSubmission(active: Active, current: () => boolean): Promise<boolean> {
    // Preserve the barrier before the first read, including navigation during that read.
    this.uncertain = active;
    const matches = (snapshot: Conversation | undefined) => {
      if (!snapshot?.messages.some(message => message.id === active.input.userMessageId)) return undefined;
      return snapshot.messages.find(message => message.id === active.input.assistantMessageId && (!active.input.generationId || message.generationId === active.input.generationId));
    };
    const terminal = (message: Message | undefined) => message && !['pending', 'streaming'].includes(message.status);
    let snapshot: Conversation | undefined;
    try { snapshot = await this.deps.api.get(active.id!); } catch { /* The original submission remains uncertain. */ }
    if (!current()) return false;
    let assistant = matches(snapshot);
    let cancelled = false;
    if (!terminal(assistant) && active.input.generationId && this.deps.api.stop) {
      try {
        // The cancellation tombstone also fences a submission that has not committed yet.
        await this.deps.api.stop(active.id!, active.input.generationId);
        if (!current()) return false;
        snapshot = await this.deps.api.get(active.id!);
        cancelled = true;
        assistant = matches(snapshot);
      } catch { /* Keep the original IDs blocked until cancellation and a read can be confirmed. */ }
    }
    if (!current()) return false;
    const absent = snapshot && !snapshot.messages.some(message => message.id === active.input.userMessageId || message.id === active.input.assistantMessageId);
    const previousRetry = active.input.retry && snapshot && !assistant;
    if (snapshot && (terminal(assistant) || (cancelled && (absent || previousRetry)))) {
      active.conversation = snapshot;
      this.uncertain = undefined;
      this.publish(snapshot); this.deps.preview(undefined);
      if (assistant) { active.accepted = true; this.deps.accepted(active.id!, active.input); }
      this.deps.error(cancelled ? '连接中断，原生成已停止并核对。已保存内容已恢复。' : '');
      return true;
    }
    this.uncertain = active;
    this.publish(snapshot ?? active.authoritative!); this.deps.preview(undefined);
    this.deps.error('提交结果尚未确认。请核对提交状态后再发送；核对时会停止仍在进行的原生成。');
    return false;
  }
  async reconcile(): Promise<boolean> {
    const active = this.uncertain;
    if (!active || this.active) return false;
    const controller = new AbortController(); active.controller = controller; this.active = active; this.deps.busy(true);
    const current = () => this.active === active && active.controller === controller && !controller.signal.aborted;
    try { return await this.reconcileSubmission(active, current); }
    finally { if (current()) { this.active = undefined; this.deps.busy(false); } }
  }
  conversationRemoved(id: string) {
    for (const [reconcile, read] of this.reads) if (read.id === id) this.releaseSnapshot(reconcile);
    this.unsaved.delete(id);
    if (this.recovering?.active.id === id) { this.recovering = undefined; this.deps.busy(false); }
    if (this.uncertain?.id !== id) return;
    this.uncertain.controller.abort(); this.uncertain = undefined; this.active = undefined;
    this.deps.preview(undefined); this.deps.busy(false); this.deps.error('');
  }
  async send(content: string, id?: string, retry?: GenerationInput, selection?: Pick<GenerationInput, 'modelId' | 'reasoning'>): Promise<boolean> {
    if (this.active || this.uncertain || this.recovering || this.hasSaveFailure(id) || !content.trim()) return false;
    const input: GenerationInput = structuredClone(retry ?? { content, userMessageId: crypto.randomUUID(), assistantMessageId: crypto.randomUUID(), retry: false, ...selection });
    if (selection || input.modelId) input.generationId = crypto.randomUUID();
    const now = new Date().toISOString();
    const line = content.trim().split('\n')[0].replace(/\s+/g, ' '); const chars = Array.from(line); const title = chars.slice(0, 24).join('') + (chars.length > 24 ? '…' : '');
    const preview: Message[] | undefined = retry ? undefined : [
      { id: input.userMessageId, conversationId: id ?? '', role: 'user', content: input.content, status: 'completed', createdAt: now },
      { id: input.assistantMessageId, conversationId: id ?? '', role: 'assistant', content: '', status: 'pending', createdAt: now, phase: 'submitting', ...(input.modelId ? { modelId: input.modelId, generationId: input.generationId, reasoning: input.reasoning } : {}) },
    ];
    const active: Active = { controller: new AbortController(), id, input, title, accepted: false, phase: 'submitting', preview };
    const controller = active.controller;
    this.active = active; this.deps.busy(true); this.deps.error('');
    const current = () => this.active === active && active.controller === controller && !controller.signal.aborted;
    const showPreview = () => { if (active.preview) this.deps.preview({ conversationId: active.id, title: active.title, phase: active.phase, messages: active.preview }); };
    const hidePreview = () => { this.deps.preview(undefined); };
    const publish = () => { if (active.conversation) this.publish(active.conversation); };
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
        active.authoritative = created;
        const messages = [...created.messages, ...(active.preview || []).map(message => ({ ...message, conversationId: created.id }))];
        withConversation({ ...created, messages }); touch();
        showPreview(); publish(); this.deps.navigate(created.id);
      } else {
        withConversation(this.deps.load?.(id) ?? await this.deps.api.get(id));
        if (!current()) return false;
        active.authoritative = active.conversation;
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
      this.deps.accepted(active.id!, active.input); publish();
      if (!response.body) throw new Error('没有收到回答内容，请重试。');
      for await (const event of readEvents(response.body, active.input.assistantMessageId, active.controller.signal)) {
        if (!current()) break;
        if (event.type === 'delta') {
          if (active.conversation?.messages.some(message => message.id === event.assistantMessageId && message.status === 'pending')) touch();
          replaceAssistant(message => ({ ...message, content: message.content + event.content, status: 'streaming', phase: undefined }));
        } else if (event.type === 'done') replaceAssistant(message => ({ ...message, status: 'completed', phase: undefined }));
        else {
          replaceAssistant(message => ({ ...message, status: 'failed', phase: undefined, error: { code: event.code, message: event.message } }));
          if (event.code === 'SAVE_FAILED') this.unsaved.set(active.id!, active);
        }
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
        if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408) {
          // A rejected submission never becomes saved history or a normal assistant retry.
          withConversation(active.authoritative!); flushFrames(); hidePreview();
          this.deps.error(message);
        } else await this.reconcileSubmission(active, current);
      } else {
        // Creation failed before any server conversation or message was accepted.
        // Keep the composer draft, but remove temporary messages and their retry UI.
        hidePreview();
        this.deps.error(message);
      }
      return false;
    } finally {
      if (this.active === active && active.controller === controller) { cancelTick(this.handle); this.handle = undefined; this.active = undefined; this.deps.busy(false); }
    }
  }
  stop() {
    if (this.recovering) { this.recovering = undefined; this.deps.busy(false); }
    if (this.uncertain) {
      const uncertain = this.uncertain; this.active = undefined; uncertain.controller.abort();
      cancelTick(this.handle); this.handle = undefined;
      if (uncertain.id && uncertain.input.generationId) void this.deps.api.stop?.(uncertain.id, uncertain.input.generationId).catch(error => { if (this.uncertain === uncertain) this.deps.error(errorText(error)); });
      this.deps.preview(undefined); this.deps.busy(false);
      // A local stop cannot confirm the remote outcome; preserve the reconciliation barrier.
      return;
    }
    const active = this.active; if (!active) return;
    this.active = undefined; active.controller.abort();
    cancelTick(this.handle); this.handle = undefined;
    if (active.id && active.input.generationId) void this.deps.api.stop?.(active.id, active.input.generationId).catch(error => this.deps.error(errorText(error)));
    const snapshot = active.id ? this.deps.terminate?.(active.id, active.input.assistantMessageId, 'stopped') : undefined;
    if (snapshot) this.publish(snapshot);
    else if (active.conversation) {
      const index = active.conversation.messages.findIndex(message => message.id === active.input.assistantMessageId);
      if (index >= 0 && ['pending', 'streaming'].includes(active.conversation.messages[index].status)) {
        const messages = active.conversation.messages.slice();
        messages[index] = { ...messages[index], status: 'stopped', phase: undefined };
        this.publish({ ...active.conversation, messages });
      }
    }
    this.deps.preview(undefined);
    this.deps.busy(false);
  }
}
