import { create } from 'zustand';
import type { Conversation } from './types';
export const useRuntime = create<{ blocked: boolean; warning: string }>(() => ({ blocked: false, warning: '' }));
type RuntimeAdapter = { reset: () => void; terminate: (id: string, messageId: string, status: 'stopped' | 'failed', error?: { code: string; message: string }) => Conversation | undefined };
let adapter: RuntimeAdapter | undefined;
export const runtime = {
  install(value: RuntimeAdapter) { adapter = value; },
  reset() { adapter?.reset(); },
  terminate(id: string, messageId: string, status: 'stopped' | 'failed', error?: { code: string; message: string }) { return adapter?.terminate(id, messageId, status, error); },
};
