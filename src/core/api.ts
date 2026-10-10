import { ApiError } from './errors';
import type { Conversation, ConversationSummary, GenerationInput } from './types';
export interface ChatApi {
  list(): Promise<ConversationSummary[]>;
  get(id: string): Promise<Conversation>;
  create(title: string, signal?: AbortSignal): Promise<Conversation>;
  rename(id: string, title: string): Promise<ConversationSummary>;
  remove(id: string): Promise<void>;
  generate(id: string, input: GenerationInput, signal: AbortSignal): Promise<Response>;
}
const base = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');
async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${base}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
  if (!response.ok) {
    let message = '请求失败，请重试。'; let code = 'REQUEST_FAILED';
    try { const data = await response.json(); message = data.error?.message || message; code = data.error?.code || code; } catch { /* Non-JSON server failure. */ }
    throw new ApiError(code, message, response.status);
  }
  return response;
}
export const api: ChatApi = {
  list: () => request('/conversations').then(r => r.json()),
  get: id => request(`/conversations/${encodeURIComponent(id)}`).then(r => r.json()),
  create: (title, signal) => request('/conversations', { method: 'POST', body: JSON.stringify({ title }), signal }).then(r => r.json()),
  rename: (id, title) => request(`/conversations/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ title }) }).then(r => r.json()),
  remove: async id => { await request(`/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
  generate: (id, input, signal) => request(`/conversations/${encodeURIComponent(id)}/generations`, { method: 'POST', body: JSON.stringify(input), signal }),
};
