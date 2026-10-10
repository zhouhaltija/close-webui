import { beforeEach, describe, expect, it } from 'vitest';
import { Repository, STORAGE_KEY } from './repository';
const input = { userMessageId: 'u', assistantMessageId: 'a', content: '你好', retry: false };
describe('browser conversation repository', () => {
  beforeEach(() => localStorage.clear());
  it('starts empty, saves and restores conversations', () => {
    const r = new Repository(localStorage); expect(r.list()).toEqual([]);
    const c = r.create('你好'); r.begin(c.id, input); r.delta(c.id, 'a', '回答'); r.finish(c.id, 'a', 'completed');
    expect(new Repository(localStorage).get(c.id).messages.map(m => m.content)).toEqual(['你好', '回答']);
  });
  it('recovers running messages as stopped without changing content', () => {
    const r = new Repository(localStorage); const c = r.create('测试'); r.begin(c.id, input); r.delta(c.id, 'a', '部分');
    expect(new Repository(localStorage).get(c.id).messages[1]).toMatchObject({ status: 'stopped', content: '部分' });
  });
  it('ignores late deltas after stopping or deleting a conversation', () => {
    const r = new Repository(localStorage); const c = r.create('测试'); r.begin(c.id, input); r.delta(c.id, 'a', '部分'); r.finish(c.id, 'a', 'stopped'); r.delta(c.id, 'a', '迟到');
    expect(r.get(c.id).messages[1].content).toBe('部分'); r.remove(c.id); r.delta(c.id, 'a', '不能复活'); expect(r.list()).toEqual([]);
  });
  it('retries the failed last answer without duplicating messages', () => {
    const r = new Repository(localStorage); const c = r.create('测试'); r.begin(c.id, input); r.delta(c.id, 'a', '部分'); r.finish(c.id, 'a', 'failed');
    r.begin(c.id, { ...input, retry: true }); r.delta(c.id, 'a', '完整'); r.finish(c.id, 'a', 'completed');
    expect(r.get(c.id).messages).toHaveLength(2); expect(r.get(c.id).messages[1].content).toBe('完整');
  });
  it('rejects blank or oversized titles and trims valid titles', () => {
    const r = new Repository(localStorage); const c = r.create('标题');
    expect(() => r.rename(c.id, '  ')).toThrow(); expect(() => r.rename(c.id, '好'.repeat(81))).toThrow();
    expect(r.rename(c.id, '  新标题  ').title).toBe('新标题');
  });
  it.each(['{broken', JSON.stringify({ version: 99, conversations: [] }), JSON.stringify({ version: 1, conversations: [{}] })])('preserves corrupt or unsupported data until reset', data => {
    localStorage.setItem(STORAGE_KEY, data); const r = new Repository(localStorage);
    expect(r.blocked).toBe(true); expect(() => r.create('测试')).toThrow(); expect(localStorage.getItem(STORAGE_KEY)).toBe(data);
    r.reset(); expect(r.blocked).toBe(false); expect(r.list()).toEqual([]);
  });
  it('continues in memory with visible feedback when writes fail', () => {
    const r = new Repository({ getItem: () => null, setItem: () => { throw new Error('quota'); } });
    const c = r.create('测试'); expect(r.get(c.id).title).toBe('测试'); expect(r.warning).not.toBe('');
  });
  it('rejects duplicate message submission and outdated retries', () => {
    const r = new Repository(localStorage); const c = r.create('测试'); r.begin(c.id, input); r.finish(c.id, 'a', 'failed');
    expect(() => r.begin(c.id, input)).toThrow(); r.begin(c.id, { ...input, userMessageId: 'u2', assistantMessageId: 'a2' });
    expect(() => r.begin(c.id, { ...input, retry: true })).toThrow();
  });
  it.each([{ role: ['user'], status: 'completed' }, { role: 'user', status: ['completed'] }])('blocks malformed role or status without coercion: %j', fields => {
    const date = '2026-10-10T00:00:00Z';
    const raw = JSON.stringify({ version: 1, conversations: [{ id: 'c', title: '测试', createdAt: date, updatedAt: date, messages: [{ id: 'm', conversationId: 'c', content: '消息', createdAt: date, ...fields }] }] });
    localStorage.setItem(STORAGE_KEY, raw); const r = new Repository(localStorage);
    expect(r.blocked).toBe(true); expect(localStorage.getItem(STORAGE_KEY)).toBe(raw);
  });
});
