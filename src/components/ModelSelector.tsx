import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Check, ChevronRight } from 'lucide-react';
import { useRef, useSyncExternalStore } from 'react';
import { useUI } from '../core/ui-store';

const subscribeViewport = (listener: () => void) => {
  window.addEventListener('resize', listener);
  return () => window.removeEventListener('resize', listener);
};

const models = [
  { name: 'Fable 5.1', description: '应对您最艰巨的挑战' },
  { name: 'Opus 5.5', description: '适用于复杂工作与日常任务' },
  { name: 'Sonnet 5.5', description: '处理简单任务效率最高' },
  { name: 'Haiku 5.5', description: '快速解答的最佳选择' },
];
const efforts = ['低', '中等', '高', '超高', '最高'];

export function ModelSelector() {
  const model = useUI(state => state.model); const effort = useUI(state => state.effort);
  const viewportWidth = useSyncExternalStore(subscribeViewport, () => window.innerWidth, () => 1024);
  const effortMenu = useRef<HTMLDivElement>(null);
  return <Dropdown.Root><Dropdown.Trigger asChild><button type="button" className="model-select" aria-label="选择模型和努力程度"><span>{model}</span><span className="effort-label">{effort}</span></button></Dropdown.Trigger>
    <Dropdown.Portal><Dropdown.Content className="model-menu" sideOffset={8} align="end" collisionPadding={16}>
      <Dropdown.RadioGroup value={model} onValueChange={value => useUI.setState({ model: value })}>{models.map(item => <Dropdown.RadioItem key={item.name} value={item.name} className="model-option"><div className="model-copy"><span>{item.name}</span><small>{item.description}</small></div><Dropdown.ItemIndicator className="model-check"><Check size={18} strokeWidth={1.8} /></Dropdown.ItemIndicator></Dropdown.RadioItem>)}</Dropdown.RadioGroup>
      <Dropdown.Separator className="model-separator" />
      <Dropdown.Sub><Dropdown.SubTrigger className="effort-trigger" onPointerLeave={event => {
        // Keep focus in the submenu when the pointer crosses directly into it.
        if (event.relatedTarget instanceof Node && effortMenu.current?.contains(event.relatedTarget)) event.preventDefault();
      }}><span>努力程度</span><span className="effort-current">{effort}</span><ChevronRight size={15} strokeWidth={1.2} /></Dropdown.SubTrigger><Dropdown.Portal><Dropdown.SubContent ref={effortMenu} className="effort-menu" sideOffset={viewportWidth < 768 ? -Math.min(322, viewportWidth - 32) : 6} collisionPadding={16}>
        <p>投入程度越高，回答越详尽，但耗时越长。</p>
        <Dropdown.RadioGroup value={effort} onValueChange={value => useUI.setState({ effort: value })}>{efforts.map(item => <Dropdown.RadioItem key={item} value={item} className="effort-option"><span>{item}</span>{item === '中等' && <small>推荐</small>}<Dropdown.ItemIndicator className="model-check"><Check size={18} strokeWidth={1.8} /></Dropdown.ItemIndicator></Dropdown.RadioItem>)}</Dropdown.RadioGroup>
      </Dropdown.SubContent></Dropdown.Portal></Dropdown.Sub>
    </Dropdown.Content></Dropdown.Portal>
  </Dropdown.Root>;
}
