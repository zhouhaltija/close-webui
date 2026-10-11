import { create } from 'zustand';
type UIState = { collapsed: boolean; mobileOpen: boolean; busy: boolean; error: string; model: string; effort: string; drafts: Record<string, string>; draft: (id: string, value: string) => void };
export const useUI = create<UIState>(set => ({ collapsed: false, mobileOpen: false, busy: false, error: '', model: 'Sonnet 5.5', effort: '中等', drafts: {}, draft: (id, value) => set(s => ({ drafts: { ...s.drafts, [id]: value } })) }));
