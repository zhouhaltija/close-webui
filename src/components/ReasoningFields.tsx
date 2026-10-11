import type { ModelCapabilities, Reasoning } from '../core/types';

export const reasoningEffortLabels: Record<string, string> = { none: '不思考', minimal: '最低', low: '低', medium: '中等', high: '高', xhigh: '超高', max: '最高' };

export function reasoningError(value: Reasoning, capabilities: ModelCapabilities, output: number): string {
  if (!Number.isInteger(output) || output <= 0 || output > capabilities.outputMax) return '输出上限超出模型支持范围。';
  if (!capabilities.known && Object.keys(value).length) return '此模型尚未核实思考能力，请使用供应商默认设置。';
  if (value.effort && !capabilities.efforts.includes(value.effort)) return '此模型不支持所选思考档位。';
  if (value.enabled === false && (!capabilities.supportsToggle || capabilities.mandatory)) return '此模型不能关闭思考。';
  if (value.enabled === true && !capabilities.supportsToggle && !capabilities.mandatory) return '此模型不支持思考开关。';
  if (value.enabled === false && (value.budgetTokens !== undefined || !capabilities.effortWhileDisabled && value.effort && value.effort !== 'none')) return '关闭思考时不能设置预算或思考档位。';
  if (value.enabled === true && value.effort === 'none') return '思考开关与档位冲突。';
  if (value.budgetTokens !== undefined) {
    const budget = value.budgetTokens;
    const special = budget === -1 && capabilities.dynamicBudget || budget === 0 && capabilities.zeroBudgetDisables;
    if (!capabilities.budgetSupported || !Number.isInteger(budget) || !special && (budget < capabilities.budgetMin || budget > capabilities.budgetMax)) return `思考预算须符合模型范围 ${capabilities.budgetMin}–${capabilities.budgetMax}。`;
    if (capabilities.budgetWithinOutput && budget >= output) return '思考预算必须小于输出上限。';
    if (value.effort && !capabilities.effortBudgetCompatible) return '思考档位与预算不能同时设置。';
    if (value.enabled === true && budget === 0 && capabilities.zeroBudgetDisables) return '启用思考时预算不能为零。';
  }
  if (capabilities.manualBudget && value.enabled === true && value.budgetTokens === undefined && output <= 1024) return '默认思考预算需要大于 1024 的输出上限。';
  if (capabilities.disabledEffortLimited && value.enabled === false && (value.effort === 'xhigh' || value.effort === 'max')) return '此思考档位不能关闭思考。';
  return '';
}
export function ReasoningFields({ capabilities: c, value, onChange, output }: { capabilities: ModelCapabilities; value: Reasoning; onChange: (v: Reasoning) => void; output: number }) {
  const set = (key: keyof Reasoning, next: boolean | string | number | undefined) => { const result = { ...value, [key]: next }; if (next === undefined) delete result[key]; onChange(result); };
  const reset = Object.keys(value).length > 0 && <button type="button" className="secondary-button" onClick={() => onChange({})}>重置为供应商默认</button>;
  if (!c.known) return <fieldset className="reasoning-fields"><legend>原生思考参数</legend><p className="field-hint">此型号尚未核实思考能力，请使用供应商默认设置。</p>{reset}</fieldset>;
  const budgetMax = c.budgetWithinOutput ? Math.min(c.budgetMax, output - 1) : c.budgetMax;
  const budgetMin = c.dynamicBudget ? -1 : c.zeroBudgetDisables ? 0 : c.budgetMin;
  return <fieldset className="reasoning-fields"><legend>原生思考参数</legend>{c.mandatory && <p className="field-hint">此模型必须启用思考。</p>}{c.supportsToggle && !c.mandatory && <label>思考开关<select value={value.enabled === undefined ? '' : String(value.enabled)} onChange={e => set('enabled', e.target.value === '' ? undefined : e.target.value === 'true')}><option value="">供应商默认</option><option value="true">开启</option><option value="false">关闭</option></select></label>}{c.efforts.length > 0 && <label>思考档位<select value={value.effort || ''} onChange={e => set('effort', e.target.value || undefined)}><option value="">供应商默认</option>{c.efforts.map(effort => <option key={effort} value={effort}>{reasoningEffortLabels[effort] || effort}</option>)}</select></label>}{c.budgetSupported && <label>思考预算<input type="number" placeholder="供应商默认" min={budgetMin} max={budgetMax} step={1} value={value.budgetTokens ?? ''} onChange={e => set('budgetTokens', e.target.value === '' ? undefined : Number(e.target.value))} /><small>{c.budgetMin}–{budgetMax} tokens，留空使用默认。{c.dynamicBudget && ' -1 表示动态预算。'}{c.zeroBudgetDisables && ' 0 表示关闭思考。'}{c.budgetWithinOutput && ' 预算须小于输出上限。'}</small></label>}{reset}</fieldset>;
}
