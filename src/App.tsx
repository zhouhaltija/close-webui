import { Component, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import { ArrowDown, Menu, MoreHorizontal, PanelLeft, Plus, Search, SlidersHorizontal } from 'lucide-react';
import { accountApi, api, sessionRequestRevision } from './core/api';
import { ApiError, errorText } from './core/errors';
import { GenerationCoordinator } from './core/generation';
import { getGreeting } from './core/greetings';
import { runtime, useRuntime } from './core/runtime';
import { useUI } from './core/ui-store';
import type { Conversation, ConversationSummary } from './core/types';
import { Composer } from './components/Composer';
import { Mark } from './components/Brand';
import { IconButton } from './components/IconButton';
import { MessageView } from './components/Messages';
import { AuthBoundary, UserMenu } from './components/Auth';
import { Settings } from './components/Settings';
import { RealModelSelector } from './components/RealModelSelector';
import { reasoningError } from './components/ReasoningFields';

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div className="recovery"><Mark large /><h1>页面暂时无法显示</h1><p>你的已保存对话不会被清除。请刷新页面再试。</p><button className="primary-button" onClick={() => location.reload()}>刷新页面</button></div> : this.props.children; }
}

function Recovery() {
  const warning = useRuntime(s => s.warning); const client = useQueryClient(); const navigate = useNavigate(); const [confirm, setConfirm] = useState(false);
  return <div className="recovery"><Mark large /><h1>无法恢复本地对话</h1><p>{warning}</p><p>重置将清除当前浏览器中的对话数据。</p><button className="primary-button" onClick={() => setConfirm(true)}>重置本地数据</button>
    <AlertDialog.Root open={confirm} onOpenChange={setConfirm}><AlertDialog.Portal><AlertDialog.Overlay className="overlay" /><AlertDialog.Content className="modal"><AlertDialog.Title>重置本地数据？</AlertDialog.Title><AlertDialog.Description>原始数据会被清除，此操作无法撤销。</AlertDialog.Description><div className="modal-actions"><AlertDialog.Cancel asChild><button className="secondary-button">取消</button></AlertDialog.Cancel><AlertDialog.Action asChild><button className="danger-button" onClick={() => { runtime.reset(); client.clear(); navigate('/'); }}>确认重置</button></AlertDialog.Action></div></AlertDialog.Content></AlertDialog.Portal></AlertDialog.Root>
  </div>;
}

export function App() {
  const location = useLocation();
  if (import.meta.env.VITE_ENABLE_MOCK === 'false') return <AuthBoundary>{location.pathname.startsWith('/settings') ? <Settings /> : <ChatApp real />}</AuthBoundary>;
  return <ChatApp />;
}

function ChatApp({ real = false }: { real?: boolean }) {
  const { conversationId } = useParams(); const navigate = useNavigate(); const location = useLocation(); const client = useQueryClient();
  const ui = useUI(); const { blocked, warning } = useRuntime();
  const models = useQuery({ queryKey: ['models'], queryFn: accountApi.models, enabled: real });
  const providers = useQuery({ queryKey: ['providers'], queryFn: accountApi.providers, enabled: real });
  const preferences = useQuery({ queryKey: ['preferences'], queryFn: accountApi.preferences, enabled: real });
  const availableModels = (models.data || []).filter(model => model.enabled && providers.data?.some(provider => provider.id === model.providerId && provider.enabled));
  const chosenId = ui.realModelId ?? preferences.data?.defaultModelId;
  const selected = availableModels.find(model => model.id === chosenId);
  const reasoning = ui.realModelId ? ui.reasoning : selected?.defaultReasoning || {};
  const parameterError = selected ? reasoningError(reasoning, selected.capabilities, selected.maxOutputTokens) : '';
  const list = useQuery({ queryKey: ['conversations'], queryFn: api.list, enabled: !blocked });
  const detail = useQuery({ queryKey: ['conversation', conversationId], queryFn: () => api.get(conversationId!), enabled: !!conversationId && !blocked });
  const [manage, setManage] = useState<{ mode: 'rename' | 'delete'; conversation: ConversationSummary }>(); const [title, setTitle] = useState(''); const [manageError, setManageError] = useState(''); const [saving, setSaving] = useState(false);
  const [welcome, setWelcome] = useState(() => ({ routeKey: location.key, text: getGreeting() }));
  if (welcome.routeKey !== location.key) setWelcome({ routeKey: location.key, text: getGreeting() });
  const greeting = welcome.text;
  const [searchOpen, setSearchOpen] = useState(false); const [searchText, setSearchText] = useState(''); const [historyOrder, setHistoryOrder] = useState('recent');
  const toolFocus = useRef<HTMLElement | null>(null);
  const restoreToolFocus = (event: Event) => { event.preventDefault(); if (toolFocus.current?.isConnected && toolFocus.current.getClientRects().length) toolFocus.current.focus(); else Array.from(document.querySelectorAll<HTMLElement>('[data-new-chat], .mobile-menu')).find(el => el.getClientRects().length)?.focus(); };
  const history = historyOrder === 'title' ? [...(list.data || [])].sort((a, b) => a.title.localeCompare(b.title, 'zh-CN')) : list.data || [];
  const returnFocus = useRef<HTMLElement | null>(null);
  const publish = (c: Conversation) => {
    const cached = client.getQueryData<Conversation>(['conversation', c.id]);
    // Stream snapshots own messages; explicit rename mutations own title metadata.
    if (cached) c = { ...c, title: cached.title, updatedAt: cached.updatedAt > c.updatedAt ? cached.updatedAt : c.updatedAt };
    client.setQueryData(['conversation', c.id], c);
    client.setQueryData<ConversationSummary[]>(['conversations'], previous => {
      const { id, title, createdAt, updatedAt } = c;
      return [...(previous || []).filter(item => item.id !== id), { id, title, createdAt, updatedAt }].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    });
  };
  const [generation] = useState(() => {
    const ownerRevision = sessionRequestRevision();
    return new GenerationCoordinator({ api, publish, busy: busy => useUI.setState({ busy }), error: error => { if (!real || ownerRevision === sessionRequestRevision()) useUI.setState({ error }); }, accepted: id => { useUI.getState().draft(id, ''); useUI.getState().draft('home', ''); }, navigate: id => { useUI.getState().draft(id, useUI.getState().drafts.home || ''); navigate(`/chat/${id}`); }, terminate: runtime.terminate });
  });
  useEffect(() => { if (generation.isActive && generation.conversationId !== conversationId) generation.stop(); useUI.setState({ mobileOpen: false }); }, [conversationId, location.pathname, generation]);
  useEffect(() => { const stop = () => generation.stop(); window.addEventListener('pagehide', stop); return () => { window.removeEventListener('pagehide', stop); generation.stop(); }; }, [generation]);
  useEffect(() => { const stop = () => generation.stop(); window.addEventListener('closewebui:session-end', stop); return () => window.removeEventListener('closewebui:session-end', stop); }, [generation]);
  const scroll = useRef<HTMLDivElement>(null); const follow = useRef(true); const lastTop = useRef(0); const [away, setAway] = useState(false);
  useLayoutEffect(() => { follow.current = true; setAway(false); const el = scroll.current; if (el) { el.scrollTop = el.scrollHeight; lastTop.current = el.scrollTop; } }, [conversationId]);
  useLayoutEffect(() => { const el = scroll.current; if (el && follow.current) { el.scrollTop = el.scrollHeight; lastTop.current = el.scrollTop; } }, [detail.data]);
  const go = (id?: string) => { generation.stop(); useUI.setState({ error: '', mobileOpen: false }); navigate(id ? `/chat/${id}` : '/'); };
  const openManage = (mode: 'rename' | 'delete', c: ConversationSummary, mobile: boolean) => {
    const container = document.querySelector(mobile ? '.mobile-drawer' : '.desktop-sidebar');
    returnFocus.current = Array.from(container?.querySelectorAll<HTMLElement>('[data-menu-id]') || []).find(el => el.dataset.menuId === c.id) || null;
    setManageError(''); setTitle(c.title); setManage({ mode, conversation: c });
  };
  const restoreFocus = (e: Event) => {
    e.preventDefault();
    if (returnFocus.current?.isConnected && returnFocus.current.getClientRects().length) returnFocus.current.focus();
    else Array.from(document.querySelectorAll<HTMLElement>('[data-new-chat], .mobile-menu')).find(el => el.getClientRects().length)?.focus();
  };
  const submitManage = async () => {
    if (!manage || saving) return; setSaving(true); setManageError('');
    try {
      if (manage.mode === 'rename') { const result = await api.rename(manage.conversation.id, title); client.setQueryData<Conversation>(['conversation', result.id], old => old ? { ...old, ...result } : old); await client.invalidateQueries({ queryKey: ['conversations'] }); }
      else { if (generation.conversationId === manage.conversation.id) generation.stop(); await api.remove(manage.conversation.id); client.removeQueries({ queryKey: ['conversation', manage.conversation.id] }); await client.invalidateQueries({ queryKey: ['conversations'] }); if (conversationId === manage.conversation.id) go(); }
      setManage(undefined);
    } catch (e) { setManageError(errorText(e)); } finally { setSaving(false); }
  };
  const sidebar = (mobile = false) => <div className={`sidebar-content ${ui.collapsed && !mobile ? 'is-collapsed' : ''}`}>
    <div className="sidebar-brand">{mobile ? <Dialog.Close asChild><button className="icon-button" aria-label="关闭侧栏"><PanelLeft size={14} strokeWidth={1} /></button></Dialog.Close> : <IconButton label={ui.collapsed ? '展开侧栏' : '收起侧栏'} onClick={() => useUI.setState({ collapsed: !ui.collapsed })}><PanelLeft size={14} strokeWidth={1} /></IconButton>}<Link to="/" onClick={e => { e.preventDefault(); go(); }} aria-label="CloseWebUI 首页"><span>CloseWebUI</span></Link></div>
    <div className="new-chat-wrap"><button className="navigation-button new-chat" data-new-chat onClick={() => go()} title="新对话" aria-label="新对话"><Plus size={16} strokeWidth={1.1} /><span>新建</span></button></div>
    <div className="sidebar-scroll">
      <div className="history-label"><span>对话记录</span><Dropdown.Root><Dropdown.Trigger asChild><button className="icon-button history-filter" aria-label="历史排序"><SlidersHorizontal size={15} strokeWidth={1} /></button></Dropdown.Trigger><Dropdown.Portal><Dropdown.Content className="dropdown" align="end"><Dropdown.RadioGroup value={historyOrder} onValueChange={setHistoryOrder}><Dropdown.RadioItem value="recent">最近更新</Dropdown.RadioItem><Dropdown.RadioItem value="title">按标题排序</Dropdown.RadioItem></Dropdown.RadioGroup></Dropdown.Content></Dropdown.Portal></Dropdown.Root></div>
      <nav aria-label="历史对话" className="history-list">{list.isPending ? <p className="sidebar-empty">正在加载…</p> : list.isError ? <div className="sidebar-empty">无法加载历史<button className="text-button" onClick={() => void list.refetch()}>重试</button></div> : !history.length ? <div className="sidebar-empty">还没有对话</div> : history.map(c => <div key={c.id} className={`history-row ${conversationId === c.id ? 'selected' : ''}`}><button onClick={() => go(c.id)} className="history-link" title={c.title}>{c.title}</button><Dropdown.Root><Dropdown.Trigger asChild><button className="icon-button history-menu" data-menu-id={c.id} aria-label={`对话菜单：${c.title}`}><MoreHorizontal size={16} strokeWidth={1.3} /></button></Dropdown.Trigger><Dropdown.Portal><Dropdown.Content className="dropdown" sideOffset={5} align="end"><Dropdown.Item onSelect={() => openManage('rename', c, mobile)}>重命名</Dropdown.Item><Dropdown.Item className="danger-text" onSelect={() => openManage('delete', c, mobile)}>删除</Dropdown.Item></Dropdown.Content></Dropdown.Portal></Dropdown.Root></div>)}</nav>
    </div>
    <div className="sidebar-footer"><button className="sidebar-search" aria-label="搜索对话" onClick={e => { toolFocus.current = e.currentTarget; setSearchText(''); setSearchOpen(true); }}><Search size={16} strokeWidth={1.3} /><span>搜索对话</span></button></div>{real && <UserMenu />}
  </div>;
  if (blocked) return <Recovery />;
  const draftId = conversationId || 'home'; const value = ui.drafts[draftId] || ''; const c = detail.data;
  const modelError = models.error || providers.error || preferences.error;
  const composer = <><Composer value={value} onChange={v => ui.draft(draftId, v)} onSend={() => { follow.current = true; setAway(false); void generation.send(value, conversationId, undefined, real && selected ? { modelId: selected.id, reasoning } : undefined); }} onStop={() => generation.stop()} busy={ui.busy} disabled={!!conversationId && (!c || detail.isError)} sendDisabled={real && (!selected || !!parameterError || !!modelError || preferences.isPending)} home={!conversationId} modelSelector={real ? <RealModelSelector models={availableModels} selected={selected} reasoning={reasoning} /> : undefined} />{real && modelError && <p className="submit-error" role="alert">{errorText(modelError)}<button className="text-button" onClick={() => { void models.refetch(); void providers.refetch(); void preferences.refetch(); }}>重新加载模型配置</button></p>}{real && parameterError && <p className="submit-error" role="alert">{parameterError}</p>}</>;
  return <Tooltip.Provider delayDuration={250}><div className={`app-shell ${ui.collapsed ? 'sidebar-collapsed' : ''}`}>
    <aside className="desktop-sidebar">{sidebar()}</aside>
    <Dialog.Root open={ui.mobileOpen} onOpenChange={mobileOpen => useUI.setState({ mobileOpen })}><Dialog.Trigger asChild><button className="mobile-menu icon-button" aria-label="打开侧栏"><Menu size={21} /></button></Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="overlay drawer-overlay" /><Dialog.Content className="mobile-drawer"><Dialog.Title className="sr-only">对话导航</Dialog.Title><Dialog.Description className="sr-only">新建对话，查看和管理历史记录</Dialog.Description>{sidebar(true)}</Dialog.Content></Dialog.Portal></Dialog.Root>
    <main className={`workspace ${conversationId ? 'chat-workspace' : 'home-workspace'}`}>{conversationId && <header className="topbar"><h1>{c?.title || '对话'}</h1></header>}
      {warning && <div className="storage-warning" role="alert">{warning}</div>}
      {!conversationId ? <section className="home-view"><div className="home-inner"><div className="welcome"><Mark large /><h2>{greeting}</h2></div>{composer}{ui.error && <p className="submit-error" role="alert">{ui.error}</p>}</div></section> : <>
        <div className="conversation-scroll" ref={scroll} onScroll={() => { const el = scroll.current; if (!el) return; if (el.scrollTop < lastTop.current - 2) follow.current = false; if (el.scrollHeight - el.clientHeight - el.scrollTop <= 80) follow.current = true; lastTop.current = el.scrollTop; setAway(!follow.current); }}>
          <div className="conversation-content">{detail.isPending ? <p className="loading-state" role="status">正在加载对话…</p> : detail.isError ? <div className="empty-detail"><h2>{detail.error instanceof ApiError && detail.error.status === 404 ? '对话不存在' : '无法加载对话'}</h2><p>{errorText(detail.error)}</p>{detail.error instanceof ApiError && detail.error.status === 404 ? <button className="secondary-button" onClick={() => go()}>返回新对话</button> : <button className="secondary-button" onClick={() => void detail.refetch()}>重试</button>}</div> : c?.messages.length ? c.messages.map((m, i) => <MessageView key={m.id} message={m} canRetry={m.status === 'failed' && i === c.messages.length - 1 && !ui.busy} onRetry={() => { const user = c.messages[i - 1]; if (user) { follow.current = true; void generation.send(user.content, c.id, { content: user.content, userMessageId: user.id, assistantMessageId: m.id, retry: true, ...(real ? { modelId: m.modelId, reasoning: m.reasoning } : {}) }); } }} />) : <div className="empty-detail"><Mark large /><h2>给这个对话一个起点</h2><p>在下方写下你的想法。</p></div>}</div>
        </div><div className="conversation-bottom">{away && <button className="back-bottom" onClick={() => { follow.current = true; setAway(false); const el = scroll.current; if (el) { el.scrollTop = el.scrollHeight; lastTop.current = el.scrollTop; } }}><ArrowDown size={15} />回到底部</button>}{ui.error && <p className="submit-error" role="alert">{ui.error}</p>}{composer}<p className="chat-footnote">回答可能有误，请核实重要信息。</p></div>
      </>}
    </main>
    <Dialog.Root open={manage?.mode === 'rename'} onOpenChange={open => { if (!open && !saving) setManage(undefined); }}><Dialog.Portal><Dialog.Overlay className="overlay" /><Dialog.Content className="modal" onCloseAutoFocus={restoreFocus}><Dialog.Title>重命名对话</Dialog.Title><Dialog.Description>给这个对话起一个容易找到的名字。</Dialog.Description><form onSubmit={e => { e.preventDefault(); void submitManage(); }}><label className="input-label" htmlFor="conversation-title">对话标题</label><input id="conversation-title" value={title} onChange={e => setTitle(e.target.value)} autoFocus disabled={saving} />{manageError && <p className="submit-error" role="alert">{manageError}</p>}<div className="modal-actions"><Dialog.Close asChild><button type="button" className="secondary-button" disabled={saving}>取消</button></Dialog.Close><button type="submit" className="primary-button" disabled={saving}>{saving ? '保存中…' : '保存标题'}</button></div></form></Dialog.Content></Dialog.Portal></Dialog.Root>
    <AlertDialog.Root open={manage?.mode === 'delete'} onOpenChange={open => { if (!open && !saving) setManage(undefined); }}><AlertDialog.Portal><AlertDialog.Overlay className="overlay" /><AlertDialog.Content className="modal" onCloseAutoFocus={restoreFocus}><AlertDialog.Title>删除这个对话？</AlertDialog.Title><AlertDialog.Description>“{manage?.conversation.title}”及其中的消息将被删除，此操作无法撤销。</AlertDialog.Description>{manageError && <p className="submit-error" role="alert">{manageError}</p>}<div className="modal-actions"><AlertDialog.Cancel asChild><button className="secondary-button" disabled={saving}>取消</button></AlertDialog.Cancel><button className="danger-button" disabled={saving} onClick={() => void submitManage()}>{saving ? '删除中…' : '确认删除'}</button></div></AlertDialog.Content></AlertDialog.Portal></AlertDialog.Root>
    <Dialog.Root open={searchOpen} onOpenChange={setSearchOpen}><Dialog.Portal><Dialog.Overlay className="overlay" /><Dialog.Content className="modal search-modal" onCloseAutoFocus={restoreToolFocus}><Dialog.Title>搜索对话</Dialog.Title><Dialog.Description>查找当前浏览器中保存的对话。</Dialog.Description><label className="sr-only" htmlFor="history-search">搜索对话标题</label><input id="history-search" autoFocus placeholder="搜索对话…" value={searchText} onChange={e => setSearchText(e.target.value)} /><div className="search-results">{(list.data || []).filter(item => item.title.toLocaleLowerCase().includes(searchText.trim().toLocaleLowerCase())).map(item => <button key={item.id} onClick={() => { setSearchOpen(false); go(item.id); }}>{item.title}</button>)}{!list.data?.some(item => item.title.toLocaleLowerCase().includes(searchText.trim().toLocaleLowerCase())) && <p>没有找到匹配的对话</p>}</div><div className="modal-actions"><Dialog.Close asChild><button className="secondary-button">关闭</button></Dialog.Close></div></Dialog.Content></Dialog.Portal></Dialog.Root>
  </div></Tooltip.Provider>;
}
