import { ApiError } from '../core/errors';
import type { Conversation, ConversationSummary, GenerationInput, Message, MessageStatus, StoredData } from '../core/types';
export const STORAGE_KEY = 'closewebui:data:v1';
export type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
const statuses = ['pending', 'streaming', 'completed', 'stopped', 'failed'];
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
function validData(v: unknown): v is StoredData {
  if (!isRecord(v) || v.version !== 1 || !Array.isArray(v.conversations)) return false;
  const ids = new Set<string>();
  return v.conversations.every(c => {
    if (!isRecord(c) || typeof c.id !== 'string' || ids.has(c.id) || typeof c.title !== 'string' || !c.title.trim() || typeof c.createdAt !== 'string' || !Number.isFinite(Date.parse(c.createdAt)) || typeof c.updatedAt !== 'string' || !Number.isFinite(Date.parse(c.updatedAt)) || !Array.isArray(c.messages)) return false;
    ids.add(c.id);
    const messages = new Set<string>();
    return c.messages.every(m => {
      if (!isRecord(m) || typeof m.id !== 'string' || messages.has(m.id) || m.conversationId !== c.id || typeof m.role !== 'string' || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || typeof m.status !== 'string' || !statuses.includes(m.status) || typeof m.createdAt !== 'string' || !Number.isFinite(Date.parse(m.createdAt))) return false;
      if (m.error !== undefined && (!isRecord(m.error) || typeof m.error.code !== 'string' || typeof m.error.message !== 'string')) return false;
      if (m.role === 'user' && m.status !== 'completed') return false;
      messages.add(m.id); return true;
    });
  });
}
const titleValue = (title: string) => {
  if (typeof title !== 'string' || !title.trim() || Array.from(title.trim()).length > 80) throw new ApiError('INVALID_TITLE', '标题需为 1–80 个字符。');
  return title.trim();
};
export class Repository {
  warning = '';
  blocked = false;
  private data: StoredData = { version: 1, conversations: [] };
  constructor(private storage: StoragePort, private onNotice: (blocked: boolean, warning: string) => void = () => {}) {
    let raw: string | null;
    try { raw = storage.getItem(STORAGE_KEY); } catch { this.warning = '无法读取本地存储。本次对话仅在当前页面保存，刷新可能丢失。'; this.notice(); return; }
    if (raw === null) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!validData(parsed)) throw new Error('invalid');
      this.data = parsed;
      let recovered = false;
      for (const c of this.data.conversations) for (const m of c.messages) if (['pending', 'streaming'].includes(m.status)) { m.status = 'stopped'; recovered = true; }
      if (recovered) this.save();
    } catch { this.blocked = true; this.warning = '已保存的数据损坏或版本不受支持。原始数据已保留。'; this.notice(); }
  }
  private notice() { this.onNotice(this.blocked, this.warning); }
  private writable() { if (this.blocked) throw new ApiError('STORAGE_BLOCKED', '请先确认重置损坏的本地数据。', 409); }
  private save() {
    this.writable();
    try { this.storage.setItem(STORAGE_KEY, JSON.stringify(this.data)); } catch { this.warning = '无法保存到本地存储。本次对话仍可使用，刷新可能丢失未保存内容。'; }
    this.notice();
  }
  private find(id: string) { const c = this.data.conversations.find(c => c.id === id); if (!c) throw new ApiError('NOT_FOUND', '对话不存在。', 404); return c; }
  list(): ConversationSummary[] {
    return this.data.conversations.map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }
  get(id: string): Conversation { return structuredClone(this.find(id)); }
  create(title: string): Conversation {
    this.writable(); const now = new Date().toISOString(); const c = { id: crypto.randomUUID(), title: titleValue(title), createdAt: now, updatedAt: now, messages: [] };
    this.data.conversations.push(c); this.save(); return structuredClone(c);
  }
  rename(id: string, title: string): ConversationSummary {
    this.writable(); const c = this.find(id); c.title = titleValue(title); c.updatedAt = new Date().toISOString(); this.save();
    return { id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt };
  }
  remove(id: string) { this.writable(); this.find(id); this.data.conversations = this.data.conversations.filter(c => c.id !== id); this.save(); }
  reset() { this.blocked = false; this.warning = ''; this.data = { version: 1, conversations: [] }; this.save(); }
  begin(id: string, input: GenerationInput) {
    this.writable(); const c = this.find(id);
    if (typeof input.content !== 'string' || !input.content.trim() || typeof input.userMessageId !== 'string' || !input.userMessageId || typeof input.assistantMessageId !== 'string' || !input.assistantMessageId || input.userMessageId === input.assistantMessageId || typeof input.retry !== 'boolean') throw new ApiError('INVALID_MESSAGE', '消息内容或标识无效。');
    if (this.data.conversations.some(c => c.messages.some(m => ['pending', 'streaming'].includes(m.status)))) throw new ApiError('BUSY', '请先停止当前回答。', 409);
    if (input.retry) {
      const last = c.messages.at(-1); const user = c.messages.at(-2);
      if (last?.id !== input.assistantMessageId || last.status !== 'failed' || last.role !== 'assistant' || user?.id !== input.userMessageId || user.content !== input.content) throw new ApiError('INVALID_RETRY', '只能重试最后一条失败回答。', 409);
      last.content = ''; last.status = 'pending'; delete last.error;
    } else {
      if (c.messages.some(m => m.id === input.userMessageId || m.id === input.assistantMessageId)) throw new ApiError('DUPLICATE_MESSAGE', '这条消息已提交。', 409);
      const now = new Date().toISOString();
      c.messages.push({ id: input.userMessageId, conversationId: id, role: 'user', content: input.content, status: 'completed', createdAt: now }, { id: input.assistantMessageId, conversationId: id, role: 'assistant', content: '', status: 'pending', createdAt: now });
      c.updatedAt = now;
    }
    this.save();
  }
  private active(id: string, messageId: string): Message | undefined { return this.data.conversations.find(c => c.id === id)?.messages.find(m => m.id === messageId && m.role === 'assistant' && ['pending', 'streaming'].includes(m.status)); }
  delta(id: string, messageId: string, content: string) { const m = this.active(id, messageId); if (!m) return; m.content += content; m.status = 'streaming'; this.save(); }
  finish(id: string, messageId: string, status: MessageStatus, error?: { code: string; message: string }) {
    const m = this.active(id, messageId); if (!m) return; m.status = status; if (error) m.error = error; this.save();
  }
}
