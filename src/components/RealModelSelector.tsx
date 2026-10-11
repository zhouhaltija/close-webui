import * as Dialog from '@radix-ui/react-dialog';
import { Check, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useUI } from '../core/ui-store';
import type { Model, Reasoning } from '../core/types';
import { ReasoningFields, reasoningEffortLabels, reasoningError } from './ReasoningFields';

export function RealModelSelector({ models, selected, reasoning }: { models: Model[]; selected?: Model; reasoning: Reasoning }) {
  const error = selected ? reasoningError(reasoning, selected.capabilities, selected.maxOutputTokens) : '';
  if (!models.length) return <Link className="model-select inline-link" to="/settings/models">配置模型</Link>;
  return <Dialog.Root><Dialog.Trigger asChild><button type="button" className="model-select" aria-label={selected ? `选择真实模型：${selected?.name || '选择模型'}` : '选择真实模型'}><span>{selected?.name || '选择模型'}</span><span className="effort-label">{reasoning.effort ? reasoningEffortLabels[reasoning.effort] || reasoning.effort : reasoning.enabled === false ? '关闭思考' : '默认'}</span></button></Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="overlay" /><Dialog.Content className="modal settings-modal real-model-modal"><Dialog.Title>选择模型</Dialog.Title><Dialog.Description>切换模型时恢复该模型保存的默认思考参数。</Dialog.Description><Dialog.Close asChild><button className="icon-button settings-modal-close" aria-label="关闭模型选择"><X size={18} /></button></Dialog.Close><div className="real-model-list" role="group" aria-label="可用模型">{models.map(model => <button key={model.id} type="button" className="real-model-option" aria-pressed={selected?.id === model.id} onClick={() => useUI.setState({ realModelId: model.id, reasoning: structuredClone(model.defaultReasoning || {}) })}><span>{model.name}<small>{model.modelId}</small></span>{selected?.id === model.id && <Check size={17} />}</button>)}</div>{selected && <ReasoningFields capabilities={selected.capabilities} value={reasoning} output={selected.maxOutputTokens} onChange={value => useUI.setState({ realModelId: selected.id, reasoning: value })} />}{error && <p className="submit-error" role="alert">{error}</p>}<div className="modal-actions"><Link className="secondary-button" to="/settings/models">管理模型</Link><Dialog.Close asChild><button type="button" className="primary-button">完成</button></Dialog.Close></div></Dialog.Content></Dialog.Portal></Dialog.Root>;
}
