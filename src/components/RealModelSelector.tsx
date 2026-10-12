import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Check, ChevronRight, Search } from 'lucide-react';
import { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { useUI } from '../core/ui-store';
import type { Model, Reasoning } from '../core/types';
import { ReasoningFields, reasoningEffortLabels, reasoningError } from './ReasoningFields';

const subscribeViewport = (listener: () => void) => {
  window.addEventListener('resize', listener);
  return () => window.removeEventListener('resize', listener);
};

/** A compact label for the trigger: the saved effort, an explicit off switch, or the provider default. */
export function reasoningSummary(reasoning: Reasoning): string {
  if (reasoning.enabled === false) return '关闭思考';
  if (reasoning.effort) return reasoningEffortLabels[reasoning.effort] || reasoning.effort;
  if (reasoning.budgetTokens !== undefined) return `预算 ${reasoning.budgetTokens}`;
  return '默认';
}

export function RealModelSelector({ models, selected, reasoning }: { models: Model[]; selected?: Model; reasoning: Reasoning }) {
  const error = selected ? reasoningError(reasoning, selected.capabilities, selected.maxOutputTokens) : '';
  const viewportWidth = useSyncExternalStore(subscribeViewport, () => window.innerWidth, () => 1024);
  const effortMenu = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState('');
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return models;
    return models.filter(model => model.name.toLowerCase().includes(needle) || model.modelId.toLowerCase().includes(needle));
  }, [filter, models]);
  const showSearch = models.length > 8;
  if (!models.length) return <Link className="model-select inline-link" to="/settings/providers">配置模型</Link>;
  return <Dropdown.Root onOpenChange={open => { if (!open) setFilter(''); }}><Dropdown.Trigger asChild><button type="button" className="model-select" aria-label={selected ? `选择真实模型：${selected.name || '选择模型'}` : '选择真实模型'}><span>{selected?.name || '选择模型'}</span><span className="effort-label">{reasoningSummary(reasoning)}</span></button></Dropdown.Trigger>
    <Dropdown.Portal><Dropdown.Content className="model-menu" sideOffset={8} align="end" collisionPadding={16}>
      {showSearch && <div className="model-search"><Search size={14} strokeWidth={1.4} aria-hidden /><input aria-label="搜索模型" placeholder="搜索模型" value={filter} onChange={event => setFilter(event.target.value)} onKeyDown={event => event.stopPropagation()} /></div>}
      {!visible.length && <p className="model-empty">没有匹配的模型。</p>}
      <Dropdown.RadioGroup value={selected?.id ?? ''} onValueChange={value => useUI.setState({ realModelId: value, reasoning: structuredClone(models.find(model => model.id === value)?.defaultReasoning || {}) })}>
        {visible.map(model => <Dropdown.RadioItem key={model.id} value={model.id} className="model-option" textValue={`${model.name} ${model.modelId}`}>
          <div className="model-copy"><span>{model.name}</span><small>{model.modelId}</small></div>
          <Dropdown.ItemIndicator className="model-check"><Check size={18} strokeWidth={1.8} /></Dropdown.ItemIndicator>
        </Dropdown.RadioItem>)}
      </Dropdown.RadioGroup>
      <Dropdown.Separator className="model-separator" />
      {selected && <Dropdown.Sub><Dropdown.SubTrigger className="effort-trigger" onPointerLeave={event => {
        // Keep focus in the submenu when the pointer crosses directly into it.
        if (event.relatedTarget instanceof Node && effortMenu.current?.contains(event.relatedTarget)) event.preventDefault();
      }}><span>思考设置</span><span className="effort-current">{reasoningSummary(reasoning)}</span><ChevronRight size={15} strokeWidth={1.2} /></Dropdown.SubTrigger>
        <Dropdown.Portal><Dropdown.SubContent ref={effortMenu} className="effort-menu effort-menu-native" sideOffset={viewportWidth < 768 ? -Math.min(360, viewportWidth - 32) : 6} collisionPadding={16}>
          <ReasoningFields capabilities={selected.capabilities} value={reasoning} output={selected.maxOutputTokens} onChange={value => useUI.setState({ realModelId: selected.id, reasoning: value })} />
        </Dropdown.SubContent></Dropdown.Portal></Dropdown.Sub>}
      {error && <p className="submit-error" role="alert">{error}</p>}
      <div className="model-menu-footer"><Link className="text-button" to="/settings/providers" onClick={() => setFilter('')}>管理供应商与模型</Link></div>
    </Dropdown.Content></Dropdown.Portal>
  </Dropdown.Root>;
}
