import { create } from 'zustand';
import type { Reasoning, SubmissionPreview } from './types';
type UIState = { collapsed: boolean; mobileOpen: boolean; busy: boolean; error: string; model: string; effort: string; realModelId: string | null; reasoning: Reasoning; drafts: Record<string, string>; preview: SubmissionPreview | null; draft: (id: string, value: string) => void };
export const useUI = create<UIState>(set => ({ collapsed: false, mobileOpen: false, busy: false, error: '', model: 'Sonnet 5.5', effort: '中等', realModelId: null, reasoning: {}, drafts: {}, preview: null, draft: (id, value) => set(s => ({ drafts: { ...s.drafts, [id]: value } })) }));
export function clearPrivateUI() { useUI.setState({ mobileOpen: false, busy: false, error: '', realModelId: null, reasoning: {}, drafts: {}, preview: null, model: 'Sonnet 5.5', effort: '中等' }); }
