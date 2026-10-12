import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, it } from 'vitest';
import type { ModelCapabilities, Reasoning } from '../core/types';
import { ReasoningFields, reasoningError } from './ReasoningFields';

const capability: ModelCapabilities = { family: 'verified', efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], supportsToggle: true, mandatory: false, budgetMin: 128, budgetMax: 8192, budgetSupported: true, outputMax: 8192, sources: [], known: true };
it('applies only the capability’s own output-budget restriction', () => {
  expect(reasoningError({ budgetTokens: 4096 }, { ...capability, budgetWithinOutput: false }, 2048)).toBe('');
  expect(reasoningError({ budgetTokens: 4096 }, { ...capability, budgetWithinOutput: true }, 2048)).not.toBe('');
});
it('allows registered dynamic and zero budgets without guessing from family names', () => {
  expect(reasoningError({ budgetTokens: -1 }, { ...capability, dynamicBudget: true }, 2048)).toBe('');
  expect(reasoningError({ budgetTokens: 0 }, { ...capability, zeroBudgetDisables: true }, 2048)).toBe('');
  expect(reasoningError({ budgetTokens: -1 }, { ...capability, dynamicBudget: false }, 2048)).not.toBe('');
  expect(reasoningError({ budgetTokens: 0 }, { ...capability, zeroBudgetDisables: false }, 2048)).not.toBe('');
});
it('rejects incompatible effort-budget and disabled-effort combinations', () => {
  expect(reasoningError({ effort: 'medium', budgetTokens: 1024 }, { ...capability, effortBudgetCompatible: false }, 4096)).not.toBe('');
  expect(reasoningError({ enabled: false, effort: 'medium' }, { ...capability, effortWhileDisabled: false }, 4096)).not.toBe('');
  expect(reasoningError({ enabled: false, effort: 'xhigh' }, { ...capability, effortWhileDisabled: true, disabledEffortLimited: true }, 4096)).not.toBe('');
  expect(reasoningError({ enabled: false, effort: 'max' }, { ...capability, effortWhileDisabled: true, disabledEffortLimited: true }, 4096)).not.toBe('');
  expect(reasoningError({ enabled: false, effort: 'high' }, { ...capability, effortWhileDisabled: true, disabledEffortLimited: true }, 4096)).toBe('');
  expect(reasoningError({ enabled: false, effort: 'medium' }, { ...capability, effortWhileDisabled: true, disabledEffortLimited: true }, 4096)).toBe('');
});
it('rejects zero budgets with explicit enabled thinking and manual defaults without enough output space', () => {
  expect(reasoningError({ enabled: true, budgetTokens: 0 }, { ...capability, zeroBudgetDisables: true }, 4096)).not.toBe('');
  expect(reasoningError({ enabled: true }, { ...capability, manualBudget: true }, 1024)).not.toBe('');
  expect(reasoningError({ enabled: true, effort: 'none' }, capability, 4096)).not.toBe('');
  expect(reasoningError({ enabled: false, budgetTokens: 1024 }, capability, 4096)).not.toBe('');
});
it('keeps native automatic and off sentinels out of the budget editor', () => {
  function Editor() {
    const [value, setValue] = useState<Reasoning>({});
    return <ReasoningFields capabilities={{ ...capability, dynamicBudget: true, zeroBudgetDisables: true, budgetWithinOutput: false }} value={value} output={2048} onChange={setValue} />;
  }
  render(<Editor />);
  const input = screen.getByRole('spinbutton', { name: /思考预算/ }); expect(input).toHaveAttribute('min', '128'); expect(input).toHaveAttribute('max', '8192');
  expect(screen.queryByText(/-1/)).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('预算方式'), { target: { value: 'auto' } });
  expect(screen.queryByRole('spinbutton', { name: /思考预算/ })).not.toBeInTheDocument();
  expect(screen.getByText('由模型自动分配思考预算。')).toBeVisible();
  fireEvent.change(screen.getByLabelText('预算方式'), { target: { value: 'off' } });
  expect(screen.queryByRole('spinbutton', { name: /思考预算/ })).not.toBeInTheDocument();
  expect(screen.getByText('此设置关闭模型的思考预算。')).toBeVisible();
});
it.each([true, false])('clears every native override only after explicit reset when capabilities are known=%s', known => {
  function Editor() {
    const [value, setValue] = useState<Reasoning>({ enabled: true, effort: 'high', budgetTokens: 1024 });
    return <><ReasoningFields capabilities={{ ...capability, known }} value={value} output={4096} onChange={setValue} /><output aria-label="当前参数">{JSON.stringify(value)}</output></>;
  }
  render(<Editor />);
  expect(screen.getByLabelText('当前参数')).toHaveTextContent('{"enabled":true,"effort":"high","budgetTokens":1024}');
  fireEvent.click(screen.getByRole('button', { name: '重置为供应商默认' }));
  expect(screen.getByLabelText('当前参数')).toHaveTextContent('{}');
  expect(screen.queryByRole('button', { name: '重置为供应商默认' })).not.toBeInTheDocument();
});

it('offers semantic budget modes only when registered and keeps default absent', () => {
  function Editor() {
    const [value, setValue] = useState<Reasoning>({});
    return <><ReasoningFields capabilities={{ ...capability, dynamicBudget: true, zeroBudgetDisables: true }} value={value} output={4096} onChange={setValue} /><output aria-label="当前参数">{JSON.stringify(value)}</output></>;
  }
  render(<Editor />);
  const mode = screen.getByLabelText('预算方式');
  fireEvent.change(mode, { target: { value: 'auto' } });
  expect(screen.getByLabelText('当前参数')).toHaveTextContent('{"budgetTokens":-1}');
  fireEvent.change(mode, { target: { value: 'off' } });
  expect(screen.getByLabelText('当前参数')).toHaveTextContent('{"budgetTokens":0}');
  fireEvent.change(mode, { target: { value: 'default' } });
  expect(screen.getByLabelText('当前参数')).toHaveTextContent('{}');
});

it('does not offer automatic or disabled budget for a model without those capabilities', () => {
  render(<ReasoningFields capabilities={capability} value={{}} output={4096} onChange={() => {}} />);
  expect(screen.getByLabelText('预算方式')).toBeVisible();
  expect(screen.queryByRole('option', { name: '自动分配' })).not.toBeInTheDocument();
  expect(screen.queryByRole('option', { name: '关闭预算' })).not.toBeInTheDocument();
});
