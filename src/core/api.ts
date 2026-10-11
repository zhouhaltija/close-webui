import { ApiError } from './errors';
import type { Conversation, ConversationSummary, GenerationInput, User, ProviderTemplate, Provider, ProviderInput, Model, ModelInput, Preferences } from './types';
export interface ChatApi {
  list(): Promise<ConversationSummary[]>;
  get(id: string): Promise<Conversation>;
  create(title: string, signal?: AbortSignal): Promise<Conversation>;
  rename(id: string, title: string): Promise<ConversationSummary>;
  remove(id: string): Promise<void>;
  generate(id: string, input: GenerationInput, signal: AbortSignal): Promise<Response>;
  stop?(id: string, generationId: string): Promise<void>;
}
const base = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');
let sessionRevision = 0;
export const sessionRequestRevision = () => sessionRevision;
export function invalidateSessionRequests() { sessionRevision++; }
async function request(path: string, init: RequestInit = {}) {
  const requestRevision = sessionRevision;
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, { credentials: 'same-origin', ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ApiError('NETWORK_ERROR', '无法连接服务，请稍后重试。', 0);
  }
  if (!response.ok) {
    if (response.status === 401 && requestRevision === sessionRevision && !['/auth/login', '/auth/register'].includes(path)) window.dispatchEvent(new Event('closewebui:unauthorized'));
    let message = '请求失败，请重试。'; let code = 'REQUEST_FAILED';
    try { const data = await response.json(); message = data.error?.message || message; code = data.error?.code || code; } catch { /* Non-JSON server failure. */ }
    throw new ApiError(code, message, response.status);
  }
  return response;
}
async function json<T>(response: Response): Promise<T> {
  try { return await response.json() as T; }
  catch { throw new ApiError('INVALID_RESPONSE', '服务返回的数据格式无效，请重试。', response.status); }
}
export const api: ChatApi = {
  list: () => request('/conversations').then(json<ConversationSummary[]>),
  get: id => request(`/conversations/${encodeURIComponent(id)}`).then(json<Conversation>),
  create: (title, signal) => request('/conversations', { method: 'POST', body: JSON.stringify({ title }), signal }).then(json<Conversation>),
  rename: (id, title) => request(`/conversations/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ title }) }).then(json<ConversationSummary>),
  remove: async id => { await request(`/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
  generate: (id, input, signal) => request(`/conversations/${encodeURIComponent(id)}/generations`, { method: 'POST', body: JSON.stringify(input), signal }),
  stop: async (id, generationId) => { await request(`/conversations/${encodeURIComponent(id)}/generations/${encodeURIComponent(generationId)}/stop`, { method: 'POST' }); },
};

const write = (path: string, value: unknown, method = 'POST') => request(path, { method, body: JSON.stringify(value) });
export const accountApi = {
  me: () => request('/auth/me').then(json<User>),
  login: (username: string, password: string) => write('/auth/login', { username, password }).then(json<User>),
  register: (username: string, password: string) => write('/auth/register', { username, password }).then(json<User>),
  logout: async () => { await request('/auth/logout', { method: 'POST' }); },
  password: async (currentPassword: string, newPassword: string) => { await write('/auth/password', { currentPassword, newPassword }); },
  templates: () => request('/provider-templates').then(json<ProviderTemplate[]>),
  providers: () => request('/providers').then(json<Provider[]>),
  saveProvider: (value: ProviderInput, id?: string) => write(id ? `/providers/${encodeURIComponent(id)}` : '/providers', value, id ? 'PATCH' : 'POST').then(json<Provider>),
  removeProvider: async (id: string) => { await request(`/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
  discover: (id: string) => request(`/providers/${encodeURIComponent(id)}/discover`, { method: 'POST' }).then(json<{ id: string; name: string }[]>),
  models: () => request('/models').then(json<Model[]>),
  saveModel: (value: ModelInput, id?: string) => write(id ? `/models/${encodeURIComponent(id)}` : '/models', value, id ? 'PATCH' : 'POST').then(json<Model>),
  removeModel: async (id: string) => { await request(`/models/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
  preferences: () => request('/preferences').then(json<Preferences>),
  savePreferences: (defaultModelId: string | null) => write('/preferences', { defaultModelId }, 'PATCH').then(json<Preferences>),
};
