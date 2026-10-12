import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it } from 'vitest';
import { useUI } from '../core/ui-store';
import type { Model, Reasoning } from '../core/types';
import { RealModelSelector, reasoningSummary } from './RealModelSelector';

it('describes semantic automatic and disabled thinking budgets in the trigger', () => {
  expect(reasoningSummary({ budgetTokens: -1 })).toBe('自动预算');
  expect(reasoningSummary({ budgetTokens: 0 })).toBe('关闭思考');
  expect(reasoningSummary({ budgetTokens: 2048 })).toBe('预算 2048');
});

afterEach(() => {
  // Close any Radix layer a test left open so its aria-hidden bookkeeping cannot leak.
  fireEvent.keyDown(document, { key: 'Escape' });
  useUI.setState({ realModelId: null, reasoning: {}, drafts: {} });
});

const known: Model['capabilities'] = { family: 'GLM', efforts: ['low', 'high', 'max'], supportsToggle: false, mandatory: true, budgetMin: 128, budgetMax: 8192, budgetSupported: true, outputMax: 32768, sources: [], known: true };
const unknown: Model['capabilities'] = { family: '', efforts: [], supportsToggle: false, mandatory: false, budgetMin: 0, budgetMax: 0, budgetSupported: false, outputMax: 4096, sources: [], known: false };
const models: Model[] = [
  { id: 'm1', providerId: 'p1', modelId: 'zai-org/GLM-5.3-Flash', name: 'GLM 5.3 Flash', enabled: true, maxOutputTokens: 32768, defaultReasoning: { effort: 'high' }, capabilities: known },
  { id: 'm2', providerId: 'p1', modelId: 'deepseek-ai/DeepSeek-V4', name: 'DeepSeek V4', enabled: true, maxOutputTokens: 32768, defaultReasoning: {}, capabilities: unknown },
];

/** Mirrors the composer wiring: the selected model and its reasoning come from the session store. */
function Harness({ available = models }: { available?: Model[] }) {
  const ui = useUI();
  const chosenId = ui.realModelId ?? 'm1';
  const selected = available.find(model => model.id === chosenId);
  const reasoning: Reasoning = ui.realModelId ? ui.reasoning : selected?.defaultReasoning || {};
  return <MemoryRouter><RealModelSelector models={available} selected={selected} reasoning={reasoning} /></MemoryRouter>;
}
function mount(initial?: { realModelId?: string | null; reasoning?: Reasoning }) {
  useUI.setState({ realModelId: initial?.realModelId ?? null, reasoning: initial?.reasoning ?? {} });
  return render(<Harness />);
}
function open(name: RegExp | string = /选择真实模型/) {
  const trigger = screen.getByRole('button', { name });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  return trigger;
}

it('opens an anchored dropdown, not a centred dialog, with names, IDs and a check mark', () => {
  mount();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  open();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  const menu = screen.getByRole('menu');
  expect(menu.className).toContain('model-menu');
  const checked = within(menu).getByRole('menuitemradio', { name: /GLM 5.3 Flash/ });
  expect(checked).toHaveAttribute('aria-checked', 'true');
  expect(within(checked).getByText('zai-org/GLM-5.3-Flash')).toBeVisible();
  expect(within(menu).getByRole('menuitemradio', { name: /DeepSeek V4/ })).toHaveAttribute('aria-checked', 'false');
  expect(within(menu).getByText('思考设置')).toBeVisible();
  expect(within(menu).getByRole('link', { name: '管理供应商与模型' })).toHaveAttribute('href', '/settings/providers');
});

const triggerLabel = () => document.querySelector('.model-select')?.getAttribute('aria-label');

it('restores the chosen model’s saved default reasoning and moves the check mark', () => {
  mount();
  open();
  fireEvent.click(screen.getByRole('menuitemradio', { name: /DeepSeek V4/ }));
  expect(useUI.getState().realModelId).toBe('m2');
  expect(useUI.getState().reasoning).toEqual({});
  expect(triggerLabel()).toBe('选择真实模型：DeepSeek V4');
  fireEvent.keyDown(document, { key: 'Escape' });
  open('选择真实模型：DeepSeek V4');
  expect(screen.getByRole('menuitemradio', { name: /DeepSeek V4/ })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('menuitemradio', { name: /GLM 5.3 Flash/ })).toHaveAttribute('aria-checked', 'false');
  expect(document.querySelector('.effort-label')).toHaveTextContent('默认');
});

it('keeps the saved default effort of the selected model and edits it in the submenu', () => {
  mount();
  expect(document.querySelector('.effort-label')).toHaveTextContent('高');
  open();
  fireEvent.click(screen.getByText('思考设置'));
  expect(screen.getByLabelText('思考档位')).toBeVisible();
  expect(within(screen.getByLabelText('思考档位')).getByRole('option', { name: '高' })).toBeVisible();
  expect(screen.queryByLabelText('思考开关')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('思考档位'), { target: { value: 'max' } });
  expect(useUI.getState().reasoning).toEqual({ effort: 'max' });
  expect(document.querySelector('.effort-label')).toHaveTextContent('最高');
});

it('keeps unknown models on the provider default without a fake effort ladder', () => {
  mount({ realModelId: 'm2' });
  open('选择真实模型：DeepSeek V4');
  fireEvent.click(screen.getByText('思考设置'));
  expect(screen.getByText(/尚未核实思考能力/)).toBeVisible();
  expect(screen.queryByLabelText('思考档位')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('思考预算')).not.toBeInTheDocument();
});

// jsdom leaves focus on <body> after a pointer-opened Radix menu closes; the browser
// assertion in tests/e2e/real-menus.spec.ts covers the focus restoration contract.
it('closes on Escape without keeping the menu in the document', () => {
  mount();
  open();
  expect(screen.getByRole('menu')).toBeVisible();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /选择真实模型/ })).toHaveAttribute('aria-expanded', 'false');
});

it('keeps the composer draft intact while switching models', () => {
  mount();
  useUI.setState({ drafts: { home: '保留草稿' } });
  open();
  fireEvent.click(screen.getByRole('menuitemradio', { name: /DeepSeek V4/ }));
  expect(useUI.getState().drafts.home).toBe('保留草稿');
  open('选择真实模型：DeepSeek V4');
  expect(screen.getByRole('link', { name: '管理供应商与模型' })).toBeVisible();
});

it('lists every available model without a search box while the list stays short', () => {
  mount();
  open();
  expect(screen.queryByLabelText('搜索模型')).not.toBeInTheDocument();
  expect(screen.getByRole('menuitemradio', { name: /GLM 5.3 Flash/ })).toBeVisible();
  expect(screen.getByRole('menuitemradio', { name: /DeepSeek V4/ })).toBeVisible();
});

it('falls back to the settings link when no real model is available', () => {
  useUI.setState({ realModelId: null, reasoning: {} });
  render(<MemoryRouter><RealModelSelector models={[]} selected={undefined} reasoning={{}} /></MemoryRouter>);
  expect(screen.getByRole('link', { name: '配置模型' })).toHaveAttribute('href', '/settings/providers');
});

it('surfaces an invalid reasoning combination so the message cannot be sent', () => {
  mount({ realModelId: 'm1', reasoning: { budgetTokens: 100000 } });
  open();
  expect(screen.getByRole('alert')).toHaveTextContent('思考预算');
});
