import type { ModelCapabilities, Reasoning } from '../core/types';
import { reasoningEffortLabels } from './ReasoningFields';

type CapabilityInfo = ModelCapabilities;
const tokens = (value: number) => value.toLocaleString('en-US');

export function thinkingDescription(c: CapabilityInfo, value: Reasoning = {}) {
  if (c.reasoningSupported === false) return '不支持思考';
  if (!c.known) return c.reasoningSupported ? '支持思考 · 具体参数未核实' : '思考能力未核实';
  const supported = c.mandatory || c.supportsToggle || c.efforts.length > 0 || c.budgetSupported;
  if (!supported) return c.reasoningSupported ? '支持思考 · 使用供应商默认' : '无可配置思考参数';
  const abilities = [c.mandatory && '强制思考', c.supportsToggle && !c.mandatory && '可开关思考', c.efforts.length > 0 && '思考档位', c.budgetSupported && '思考预算'].filter(Boolean).join(' / ');
  const current = [value.enabled === false && '关闭', value.enabled === true && '开启', value.effort && (reasoningEffortLabels[value.effort] || value.effort), value.budgetTokens !== undefined && (value.budgetTokens === -1 && c.dynamicBudget ? '自动预算' : value.budgetTokens === 0 && c.zeroBudgetDisables ? '关闭预算' : `${tokens(value.budgetTokens)} tokens`)].filter(Boolean).join(' / ');
  return `${abilities} · 当前：${current || '供应商默认'}`;
}

export function ModelMetadata({ capabilities: c, output, reasoning = {} }: { capabilities: CapabilityInfo; output: number; reasoning?: Reasoning }) {
  const source = c.outputSource || (c.known ? 'catalog' : 'conservative');
  return <div className="model-metadata">
    <div className="model-output-summary"><span>每次回复上限 {tokens(output)} tokens</span><span>{source === 'conservative' ? '保守输出上限' : '模型最大输出'} {tokens(c.outputMax)} tokens</span></div>
    <p className="model-thinking-summary">{thinkingDescription(c, reasoning)}</p>
    <p className="model-limit-source">{source === 'upstream' ? '上游提供限值' : source === 'catalog' ? '内置目录限值' : '最大输出未核实，采用保守限值'}{c.contextWindow ? ` · 上下文 ${tokens(c.contextWindow)} tokens` : ''}</p>
  </div>;
}
