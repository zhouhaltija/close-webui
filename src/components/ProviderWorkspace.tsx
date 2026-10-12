import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowLeft, ChevronDown, Plus, Search, Settings2, X } from 'lucide-react';
import { accountApi, sessionRequestRevision } from '../core/api';
import { errorText } from '../core/errors';
import type { Adapter, Model, ModelBatchEntry, ModelBatchResult, Protocol, Provider, ProviderInput, Reasoning } from '../core/types';
import { ReasoningFields, reasoningError } from './ReasoningFields';
import { reasoningSummary } from './RealModelSelector';
import { ModelMetadata } from './ModelMetadata';

const protocols: { id: Protocol; name: string }[] = [{ id: 'openai-chat', name: 'OpenAI Chat Completions' }, { id: 'openai-responses', name: 'OpenAI Responses' }, { id: 'gemini', name: 'Gemini' }, { id: 'anthropic', name: 'Anthropic' }];
const adapters: { id: Adapter; name: string }[] = [{ id: 'standard', name: '标准适配' }, { id: 'openrouter', name: 'OpenRouter' }, { id: 'siliconflow', name: '硅基流动' }, { id: 'deepseek', name: 'DeepSeek（深度求索）' }, { id: 'qwen', name: '通义千问' }, { id: 'kimi', name: 'Kimi（月之暗面）' }, { id: 'glm', name: '智谱 GLM' }];
const batchStatusLabels: Record<ModelBatchResult['status'], string> = { added: '已添加', exists: '已存在（未改写）', failed: '失败' };
type ProviderForm = { name: string; templateId: string; protocol: Protocol; adapter: Adapter; baseUrl: string; apiKey: string; enabled: boolean };
const blankForm: ProviderForm = { name: '', templateId: 'custom', protocol: 'openai-chat', adapter: 'standard', baseUrl: '', apiKey: '', enabled: true };
const formFrom = (provider: Provider): ProviderForm => ({ name: provider.name, templateId: provider.templateId, protocol: provider.protocol, adapter: provider.adapter, baseUrl: provider.baseUrl, apiKey: '', enabled: provider.enabled });
const isDirty = (form: ProviderForm, provider: Provider | undefined, isNew: boolean) => {
  if (isNew || !provider) return !!form.name.trim() || !!form.baseUrl.trim() || !!form.apiKey.trim();
  return form.name.trim() !== provider.name || form.templateId !== provider.templateId || form.protocol !== provider.protocol || form.adapter !== provider.adapter || form.baseUrl.trim() !== provider.baseUrl || form.enabled !== provider.enabled || !!form.apiKey.trim();
};
/** The candidate cache is scoped to the provider and its connection configuration, so a late response can never land in another provider's pane. */
const candidateKey = (provider: Provider) => ['provider-candidates', provider.id, sessionRequestRevision(), provider.updatedAt || '', `${provider.protocol}|${provider.adapter}|${provider.baseUrl}|${provider.enabled}`] as const;
const routeProviderId = (params: { providerId?: string }, pathname: string) => {
  const raw = params.providerId ?? pathname.match(/^\/settings\/providers\/([^/]+)/)?.[1] ?? '';
  try { return decodeURIComponent(raw); } catch { return raw; }
};
const catalogOf = async (id: string) => { try { return await accountApi.catalog(id); } catch { return undefined; } };
/** Upstream first; on failure, timeout, or an empty upstream list the built-in catalog is offered with the real reason. */
async function fetchCandidates(provider: Provider) {
  let upstream;
  try { upstream = await accountApi.candidates(provider.id); }
  catch (error) {
    const catalog = await catalogOf(provider.id);
    if (catalog?.models?.length) return { source: 'catalog' as const, catalogVersion: catalog.catalogVersion, warning: `上游发现失败：${errorText(error)}。以下为内置目录候选，列出不代表连接成功。`, models: catalog.models };
    throw error;
  }
  if (upstream.models.length || upstream.source !== 'upstream') return upstream;
  const catalog = await catalogOf(provider.id);
  if (catalog?.models?.length) return { source: 'catalog' as const, catalogVersion: catalog.catalogVersion, warning: upstream.warning || '上游未返回可用模型。以下为内置目录候选，列出不代表连接成功。', models: catalog.models };
  return upstream;
}

export function useAction() {
  const [pending, setPending] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  return { pending, error, notice, reset: () => { setError(''); setNotice(''); }, run: async (action: () => Promise<void>, message = '') => { if (pending) return; setPending(true); setError(''); setNotice(''); try { await action(); setNotice(message); } catch (e) { setError(errorText(e)); } finally { setPending(false); } } };
}
export function Feedback({ error, notice }: { error: string; notice: string }) { return <>{error && <p className="submit-error" role="alert">{error}</p>}{notice && <p className="settings-notice" role="status">{notice}</p>}</>; }
export function ConfirmDelete({ title, children, remove }: { title: string; children: ReactNode; remove: () => Promise<void> }) {
  const action = useAction(); const [open, setOpen] = useState(false);
  return <AlertDialog.Root open={open} onOpenChange={setOpen}><AlertDialog.Trigger asChild><button className="secondary-button danger-text" aria-label={`删除${title}`}>删除</button></AlertDialog.Trigger><AlertDialog.Portal><AlertDialog.Overlay className="overlay" /><AlertDialog.Content className="modal"><AlertDialog.Title>删除{title}？</AlertDialog.Title><AlertDialog.Description>{children}</AlertDialog.Description><Feedback {...action} /><div className="modal-actions"><AlertDialog.Cancel asChild><button className="secondary-button" disabled={action.pending}>取消</button></AlertDialog.Cancel><button className="danger-button" disabled={action.pending} onClick={() => void action.run(async () => { await remove(); setOpen(false); })}>确认删除</button></div></AlertDialog.Content></AlertDialog.Portal></AlertDialog.Root>;
}

type Guard = { dirty: () => boolean; snapshot: () => ProviderForm | null };
const noGuard: Guard = { dirty: () => false, snapshot: () => null };

function ProviderDetail({ provider, isNew, drafts, guard, onCreated, onCancelNew, onDeleted, onBack }: { provider?: Provider; isNew: boolean; drafts: { current: Map<string, ProviderForm> }; guard: { current: Guard }; onCreated: (provider: Provider) => void; onCancelNew: () => void; onDeleted: (id: string) => void; onBack: () => void }) {
  const client = useQueryClient();
  const { search } = useLocation();
  const linkedModelId = new URLSearchParams(search).get('model');
  const models = useQuery({ queryKey: ['models'], queryFn: accountApi.models });
  const preferences = useQuery({ queryKey: ['preferences'], queryFn: accountApi.preferences });
  const templates = useQuery({ queryKey: ['provider-templates'], queryFn: accountApi.templates });
  const [form, setForm] = useState<ProviderForm>(() => drafts.current.get(isNew ? 'new' : provider?.id || '') ?? (provider ? formFrom(provider) : { ...blankForm }));
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [modelDraft, setModelDraft] = useState<{ maxOutputTokens: number; defaultReasoning: Reasoning }>({ maxOutputTokens: 4096, defaultReasoning: {} });
  const [savingModel, setSavingModel] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualForm, setManualForm] = useState({ modelId: '', name: '', maxOutputTokens: 4096, enabled: true });
  const [feedback, setFeedback] = useState<{ error: string; notice: string }>({ error: '', notice: '' });
  const [saving, setSaving] = useState(false);
  const manual = useAction();
  const modelAction = useAction();
  const manualReturn = useRef<HTMLElement | null>(null);
  const candidates = useQuery({ queryKey: provider ? candidateKey(provider) : ['provider-candidates', 'new'], queryFn: () => fetchCandidates(provider as Provider), enabled: false, retry: false, staleTime: Infinity });
  const batch = useMutation({ mutationFn: (entries: ModelBatchEntry[]) => accountApi.batchModels(provider!.id, entries), onSuccess: async () => { setPicked([]); await client.invalidateQueries({ queryKey: ['models'] }); } });
  useEffect(() => { guard.current = { dirty: () => isDirty(form, provider, isNew), snapshot: () => form }; }, [form, provider, isNew, guard]);
  useLayoutEffect(() => { if (manualOpen && document.activeElement instanceof HTMLElement) manualReturn.current = document.activeElement; }, [manualOpen]);
  const data = candidates.data;
  const own = (models.data || []).filter(model => model.providerId === provider?.id);
  const needle = filter.trim().toLowerCase();
  const visible = own.filter(model => !needle || model.name.toLowerCase().includes(needle) || model.modelId.toLowerCase().includes(needle));
  const editModel = own.find(model => model.id === editing);
  const modelError = editModel && editing ? reasoningError(modelDraft.defaultReasoning, editModel.capabilities, modelDraft.maxOutputTokens) : '';
  const invalidateModels = async () => { await Promise.all([client.invalidateQueries({ queryKey: ['models'] }), client.invalidateQueries({ queryKey: ['preferences'] })]); };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true); setFeedback({ error: '', notice: '' });
    const revision = sessionRequestRevision();
    const input: ProviderInput = { name: form.name.trim(), templateId: form.templateId, protocol: form.protocol, adapter: form.adapter, baseUrl: form.baseUrl.trim(), enabled: form.enabled };
    // A blank key field never sends apiKey, so the backend keeps the retained key.
    if (form.apiKey.trim()) input.apiKey = form.apiKey;
    void (async () => {
      try {
        if (isNew || !provider) {
          const created = await accountApi.saveProvider(input);
          if (revision !== sessionRequestRevision()) return;
          drafts.current.delete('new');
          await client.invalidateQueries({ queryKey: ['providers'] });
          if (revision !== sessionRequestRevision()) return;
          onCreated(created);
        } else {
          const saved = await accountApi.saveProvider(input, provider.id);
          if (revision !== sessionRequestRevision()) return;
          drafts.current.delete(provider.id);
          setForm(formFrom(saved));
          await Promise.all([client.invalidateQueries({ queryKey: ['providers'] }), client.invalidateQueries({ queryKey: ['models'] })]);
          if (revision !== sessionRequestRevision()) return;
          setFeedback({ error: '', notice: '供应商已保存。' });
        }
      } catch (e) { setFeedback({ error: errorText(e), notice: '' }); } finally { setSaving(false); }
    })();
  };
  const pull = () => {
    if (!provider) return;
    const revision = sessionRequestRevision();
    void client.fetchQuery({ queryKey: candidateKey(provider), queryFn: () => fetchCandidates(provider), staleTime: 0 }).then(async () => {
      if (revision === sessionRequestRevision()) await client.invalidateQueries({ queryKey: ['models'] });
    }).catch(() => {});
  };
  const toggleKey = ['model-toggle', sessionRequestRevision()] as const;
  const pendingToggles = useMutationState({ filters: { mutationKey: toggleKey, status: 'pending' }, select: mutation => (mutation.state.variables as { model: Model }).model.id });
  const toggle = useMutation({ mutationKey: toggleKey, mutationFn: async ({ model, enabled, revision }: { model: Model; enabled: boolean; revision: number }) => {
    if (revision !== sessionRequestRevision()) return;
    const previous = client.getQueryData<Model[]>(['models'])?.find(item => item.id === model.id);
    client.setQueryData<Model[]>(['models'], current => current?.map(item => item.id === model.id ? { ...item, enabled } : item));
    const optimistic = client.getQueryData<Model[]>(['models'])?.find(item => item.id === model.id);
    try { await accountApi.saveModel({ providerId: model.providerId, modelId: model.modelId, name: model.name, enabled, maxOutputTokens: model.maxOutputTokens, defaultReasoning: model.defaultReasoning }, model.id); }
    catch (e) {
      if (revision !== sessionRequestRevision()) return;
      if (previous && optimistic) client.setQueryData<Model[]>(['models'], current => current?.map(item => item === optimistic ? previous : item));
      if (active.current) setFeedback({ error: errorText(e), notice: '' });
    }
  } });
  const toggleModel = (model: Model, enabled: boolean) => {
    // The mutation cache locks immediately and remains shared when this detail pane remounts.
    if (client.isMutating({ mutationKey: toggleKey, predicate: mutation => (mutation.state.variables as { model: Model }).model.id === model.id })) return;
    toggle.mutate({ model, enabled, revision: sessionRequestRevision() });
  };
  const openModelEditor = (model: Model) => { setEditing(model.id); setModelDraft({ maxOutputTokens: model.maxOutputTokens, defaultReasoning: { ...model.defaultReasoning } }); };
  const openedLink = useRef<string | null>(null);
  useEffect(() => {
    const model = models.data?.find(item => item.id === linkedModelId && item.providerId === provider?.id);
    if (!model || openedLink.current === linkedModelId) return;
    openedLink.current = linkedModelId;
    setEditing(model.id);
    setModelDraft({ maxOutputTokens: model.maxOutputTokens, defaultReasoning: { ...model.defaultReasoning } });
  }, [linkedModelId, models.data, provider?.id]);
  const saveModelEditor = async (model: Model) => {
    if (modelError || savingModel) return;
    setSavingModel(true);
    try {
      await accountApi.saveModel({ providerId: model.providerId, modelId: model.modelId, name: model.name, enabled: model.enabled, maxOutputTokens: modelDraft.maxOutputTokens, defaultReasoning: modelDraft.defaultReasoning }, model.id);
      await invalidateModels();
      setEditing(null);
      setFeedback({ error: '', notice: `已保存${model.name}的原生思考参数。` });
    } catch (e) { setFeedback({ error: errorText(e), notice: '' }); } finally { setSavingModel(false); }
  };
  const submitManual = (event: FormEvent) => {
    event.preventDefault();
    void manual.run(async () => {
      await accountApi.saveModel({ providerId: provider!.id, modelId: manualForm.modelId.trim(), name: manualForm.name.trim(), enabled: manualForm.enabled, maxOutputTokens: manualForm.maxOutputTokens, defaultReasoning: {} });
      await client.invalidateQueries({ queryKey: ['models'] });
      setManualOpen(false);
      setFeedback({ error: '', notice: '模型已添加。' });
    }, '模型已添加。');
  };
  const results = batch.data?.results || [];
  const counts = { added: results.filter(item => item.status === 'added').length, exists: results.filter(item => item.status === 'exists').length, failed: results.filter(item => item.status === 'failed').length };
  return <>
    <header className="provider-detail-heading">
      <button type="button" className="secondary-button provider-back" onClick={onBack}><ArrowLeft size={14} />返回供应商列表</button>
      <div className="provider-detail-title">
        <h1>{isNew ? '添加供应商' : provider?.name}</h1>
        <p>{isNew ? '填写基础配置后保存，保存成功会自动拉取一次模型。' : `${protocols.find(item => item.id === provider?.protocol)?.name || provider?.protocol} · ${adapters.find(item => item.id === provider?.adapter)?.name || provider?.adapter}`}</p>
      </div>
      {provider && <span className="status-pill">{provider.hasKey ? '密钥已配置' : '未配置密钥'}</span>}
    </header>
    <form className="settings-form provider-form" onSubmit={save}>
      <div className="settings-group-heading"><div><h2>连接配置</h2><p>填写接口地址和密钥，连接你的模型服务。</p></div><span className="section-index">01</span></div>
      <fieldset disabled={saving}>
        {isNew && <label className="setting-field-row"><span>模板<small>选择服务以自动填写连接信息。</small></span><select aria-label="模板" value={form.templateId} onChange={event => { const template = templates.data?.find(item => item.id === event.target.value); setForm(template ? { ...form, templateId: template.id, name: template.name, protocol: template.protocol, adapter: template.adapter, baseUrl: template.baseUrl } : { ...form, templateId: 'custom' }); }}><option value="custom">自定义供应商</option>{templates.data?.filter(template => template.id !== 'custom').map(template => <option value={template.id} key={template.id}>{template.name}</option>)}</select></label>}
        {isNew && templates.isError && <p className="field-hint">模板加载失败，仍可手动填写。</p>}
        <label className="setting-field-row"><span>名称<small>用于区分你添加的供应商。</small></span><input aria-label="名称" required maxLength={80} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
        <label className="setting-field-row"><span>接口地址<small>供应商的 API 基础地址。</small></span><input aria-label="接口地址" type="url" required value={form.baseUrl} onChange={event => setForm({ ...form, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></label>
        <label className="setting-field-row"><span>API 密钥<small>{provider?.hasKey ? '已保存密钥，留空保持不变。' : '密钥仅用于此供应商的请求。'}</small></span><input aria-label="API 密钥" type="password" autoComplete="off" value={form.apiKey} onChange={event => setForm({ ...form, apiKey: event.target.value })} placeholder={provider?.hasKey ? '留空则不修改已保存的密钥' : '输入 API 密钥'} /></label>
        <details className="provider-advanced" open={isNew || undefined}><summary>高级配置<ChevronDown size={14} /></summary><div>
          <label className="setting-field-row"><span>接口协议<small>选择服务支持的请求格式。</small></span><select aria-label="接口协议" value={form.protocol} onChange={event => setForm({ ...form, protocol: event.target.value as Protocol })}>{protocols.map(protocol => <option key={protocol.id} value={protocol.id}>{protocol.name}</option>)}</select></label>
          <label className="setting-field-row"><span>参数适配<small>使用供应商对应的原生参数。</small></span><select aria-label="参数适配" value={form.adapter} onChange={event => setForm({ ...form, adapter: event.target.value as Adapter })}>{adapters.map(adapter => <option key={adapter.id} value={adapter.id}>{adapter.name}</option>)}</select></label>
        </div></details>
        <label className="check-field provider-enabled"><span>启用供应商<small>停用后保留已有模型与聊天历史。</small></span><input aria-label="启用供应商" type="checkbox" checked={form.enabled} onChange={event => setForm({ ...form, enabled: event.target.checked })} /></label>
      </fieldset>
      <Feedback error={feedback.error} notice={feedback.notice} />
      <div className="settings-card-actions">
        <button className="primary-button" type="submit" disabled={saving}>{saving ? '保存中…' : '保存供应商'}</button>
        {isNew ? <button type="button" className="secondary-button" disabled={saving} onClick={onCancelNew}>取消</button> : <ConfirmDelete title={provider?.name || '供应商'} remove={async () => { if (provider) { await accountApi.removeProvider(provider.id); onDeleted(provider.id); } }}>关联模型也会删除，已有对话仍然保留。</ConfirmDelete>}
      </div>
    </form>
    {!isNew && provider && <section className="provider-models">
      <div className="settings-section-title">
        <div><h2>模型 <span className="section-count">{own.length}</span></h2><p>管理回复长度与原生思考设置。</p></div>
        <div className="provider-model-toolbar"><button type="button" className="secondary-button" disabled={candidates.isFetching} onClick={pull}>{candidates.isFetching ? '拉取中…' : '拉取模型'}</button>
      <div className="provider-models-actions">
        <Dialog.Root open={manualOpen} onOpenChange={open => { if (!manual.pending) setManualOpen(open); }}>
          <Dialog.Trigger asChild><button type="button" className="secondary-button" onClick={() => { manual.reset(); setManualForm({ modelId: '', name: '', maxOutputTokens: 4096, enabled: true }); }}>手动添加模型</button></Dialog.Trigger>
          <Dialog.Portal><Dialog.Overlay className="overlay" /><Dialog.Content className="modal settings-modal" onCloseAutoFocus={event => { event.preventDefault(); if (manualReturn.current?.isConnected) manualReturn.current.focus(); }}>
            <Dialog.Title>手动添加模型</Dialog.Title>
            <Dialog.Description>填写供应商支持的准确模型 ID；保存后按已核实能力显示思考参数。</Dialog.Description>
            <Dialog.Close asChild><button className="icon-button settings-modal-close" aria-label="关闭编辑"><X size={18} /></button></Dialog.Close>
            <form className="settings-form" onSubmit={submitManual}>
              <fieldset disabled={manual.pending}>
                <label>模型 ID<input required value={manualForm.modelId} onChange={event => setManualForm({ ...manualForm, modelId: event.target.value })} placeholder="供应商提供的模型标识" /></label>
                <label>显示名称<input required maxLength={80} value={manualForm.name} onChange={event => setManualForm({ ...manualForm, name: event.target.value })} /></label>
                <label>输出上限<input type="number" required min={1} step={1} value={manualForm.maxOutputTokens} onChange={event => setManualForm({ ...manualForm, maxOutputTokens: Number(event.target.value) })} /><small>tokens；须符合模型限制</small></label>
                <label className="check-field"><input type="checkbox" checked={manualForm.enabled} onChange={event => setManualForm({ ...manualForm, enabled: event.target.checked })} />启用模型</label>
              </fieldset>
              <Feedback error={manual.error} notice={manual.notice} />
              <div className="modal-actions"><button type="button" className="secondary-button" disabled={manual.pending} onClick={() => setManualOpen(false)}>取消</button><button type="submit" className="primary-button" disabled={manual.pending}>{manual.pending ? '保存中…' : '添加模型'}</button></div>
            </form>
          </Dialog.Content></Dialog.Portal>
        </Dialog.Root>
      </div>
</div>
      </div>
      <div className="model-search"><Search size={14} strokeWidth={1.4} aria-hidden /><input aria-label="搜索模型" placeholder="搜索已添加模型" value={filter} onChange={event => setFilter(event.target.value)} /></div>
      <Feedback {...modelAction} />
      {candidates.isError && <p className="submit-error" role="alert">{errorText(candidates.error)}</p>}
      {data && <>
        {data.warning && <p className="candidate-warning" role="status">{data.warning}</p>}
        {!!data.models.length && <div className="candidate-area">
          <div className="candidate-area-head">
            <span className="source-badge">{data.source === 'upstream' ? '上游返回' : '内置目录'}</span>
            <span className="field-hint">目录版本 {data.catalogVersion} · 已选 {picked.length} 项</span>
            <button type="button" className="primary-button" disabled={!picked.length || batch.isPending} onClick={() => batch.mutate(data.models.filter(entry => picked.includes(entry.id)).map<ModelBatchEntry>(entry => ({ modelId: entry.id, name: entry.name, maxOutputTokens: entry.recommendedDefaults.maxOutputTokens, enabled: true })))}>{batch.isPending ? '添加中…' : '批量添加'}</button>
          </div>
          <div className="candidate-list">{data.models.map(entry => <label className={`candidate${picked.includes(entry.id) ? ' candidate-selected' : ''}`} key={entry.id}>
            <span className="candidate-head"><input type="checkbox" checked={picked.includes(entry.id)} onChange={event => setPicked(current => event.target.checked ? [...current, entry.id] : current.filter(item => item !== entry.id))} /><span className="candidate-name">{entry.name}</span></span>
            <small>{entry.id}</small>
            <ModelMetadata capabilities={entry.capabilities} output={entry.recommendedDefaults.maxOutputTokens} reasoning={entry.recommendedDefaults.defaultReasoning} />
            <small>推荐输出上限 {entry.recommendedDefaults.maxOutputTokens} tokens · 默认思考 {reasoningSummary(entry.recommendedDefaults.defaultReasoning)}{entry.verifiedDate ? ` · 核实于 ${entry.verifiedDate}` : ''}</small>
            {entry.notes && <small>{entry.notes}</small>}
          </label>)}</div>
        </div>}
        {!data.models.length && !data.warning && <p className="field-hint">没有候选模型，可手动输入模型 ID。</p>}
      </>}
      {batch.isError && <p className="submit-error" role="alert">{errorText(batch.error)}</p>}
      {!!results.length && <div className="batch-results" role="status"><p>{`批量添加完成：已添加 ${counts.added} 项，已存在 ${counts.exists} 项，失败 ${counts.failed} 项。`}</p><ul>{results.map(result => <li key={result.modelId}>{`${result.modelId} · ${batchStatusLabels[result.status]}${result.error ? `：${result.error}` : ''}`}</li>)}</ul></div>}
      {!data && !candidates.isFetching && !candidates.isError && <p className="field-hint">点击“拉取模型”从上游获取候选；失败时会说明原因并列出内置目录候选。</p>}
      {models.isPending ? <p role="status">正在加载模型…</p> : models.isError ? <p className="submit-error" role="alert">{errorText(models.error)}<button className="text-button" onClick={() => void models.refetch()}>重试</button></p> : <div className="model-rows">
        {!visible.length && <div className="settings-empty"><h3>{needle ? '没有匹配的模型' : '此供应商还没有已添加模型。'}</h3><p>{needle ? '试试其他名称或模型 ID。' : '拉取模型以选择候选，或手动添加模型。'}</p></div>}
        {visible.map(model => <article className="settings-card model-row" key={model.id}>
          <div className="model-row-heading">
            <div className="model-row-copy"><div className="model-name-line"><h3>{model.name}</h3>{preferences.data?.defaultModelId === model.id && <span className="status-pill">默认模型</span>}</div><p className="model-row-id">{model.modelId}</p></div>
            <div className="model-primary-actions"><button type="button" className="secondary-button model-config-button" aria-label={`${model.name}的模型设置`} aria-expanded={editing === model.id} onClick={() => openModelEditor(model)}><Settings2 size={14} />模型设置</button><label className="check-field model-enabled"><input type="checkbox" aria-label={`启用${model.name}`} checked={model.enabled} disabled={pendingToggles.includes(model.id)} onChange={event => toggleModel(model, event.target.checked)} /><span>{model.enabled ? '已启用' : '已停用'}</span></label></div>
          </div>
          <ModelMetadata capabilities={model.capabilities} output={model.maxOutputTokens} reasoning={model.defaultReasoning} />
          <div className="model-secondary-actions">
            <button type="button" className="secondary-button" aria-label={`将${model.name}设为默认`} disabled={!model.enabled || !provider.enabled || preferences.data?.defaultModelId === model.id} onClick={() => void modelAction.run(async () => { await accountApi.savePreferences(model.id); await invalidateModels(); }, '默认模型已保存。')}>设为默认</button>
            <ConfirmDelete title={model.name} remove={async () => { await accountApi.removeModel(model.id); await invalidateModels(); }}>删除后无法使用此模型发送新消息，历史仍然保留。</ConfirmDelete>
          </div>
          {editing === model.id && <section className="model-inline-editor" aria-label={`${model.name}的模型设置`}>
            <div className="model-editor-heading"><h4>模型设置</h4><p>设置每次回复的输出长度和默认思考行为。</p></div>
            <label>输出上限<input aria-label="输出上限" type="number" required min={1} step={1} max={model.capabilities.outputMax} value={modelDraft.maxOutputTokens} onChange={event => setModelDraft({ ...modelDraft, maxOutputTokens: Number(event.target.value) })} /><small>每次回复最多生成的 tokens；不能超过上方模型输出限制。</small></label>
            <ReasoningFields capabilities={model.capabilities} value={modelDraft.defaultReasoning} onChange={defaultReasoning => setModelDraft({ ...modelDraft, defaultReasoning })} output={modelDraft.maxOutputTokens} />
            {modelError && <p className="submit-error" role="alert">{modelError}</p>}
            <div className="settings-card-actions">
              <button type="button" className="primary-button" disabled={!!modelError || savingModel} onClick={() => void saveModelEditor(model)}>{savingModel ? '保存中…' : '保存参数'}</button>
              <button type="button" className="secondary-button" onClick={() => setEditing(null)}>取消</button>
            </div>
          </section>}
        </article>)}
      </div>}
    </section>}
  </>;
}

export function ProviderWorkspace() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const params = useParams<{ providerId?: string }>();
  const { pathname } = useLocation();
  const providers = useQuery({ queryKey: ['providers'], queryFn: accountApi.providers });
  const list = providers.data || [];
  const routeId = routeProviderId(params, pathname);
  const [adding, setAdding] = useState(false);
  const [providerFilter, setProviderFilter] = useState('');
  const providerNeedle = providerFilter.trim().toLowerCase();
  const filteredProviders = list.filter(provider => !providerNeedle || provider.name.toLowerCase().includes(providerNeedle) || provider.baseUrl.toLowerCase().includes(providerNeedle));
  const [mobileView, setMobileView] = useState<'list' | 'detail'>(() => (routeId ? 'detail' : 'list'));
  const [pendingSwitch, setPendingSwitch] = useState<{ target: string } | null>(null);
  const drafts = useRef(new Map<string, ProviderForm>());
  const guard = useRef<Guard>(noGuard);
  const selectedId = adding ? 'new' : routeId || list[0]?.id || '';
  const selectedProvider = list.find(provider => provider.id === selectedId);
  const notFound = !adding && !!routeId && !providers.isPending && !providers.isFetching && !providers.isError && !selectedProvider;
  const applySwitch = (target: string) => {
    setAdding(target === 'new');
    setMobileView(target === '__back__' ? 'list' : 'detail');
    navigate(target === 'new' || target === '__back__' ? '/settings/providers' : `/settings/providers/${encodeURIComponent(target)}`);
  };
  const requestSwitch = (target: string) => {
    if (target === 'new' ? adding : target === selectedId) { setMobileView('detail'); return; }
    if (guard.current.dirty()) { setPendingSwitch({ target }); return; }
    applySwitch(target);
  };
  const resolveSwitch = (keep: boolean) => {
    const target = pendingSwitch?.target; setPendingSwitch(null);
    if (!target) return;
    if (keep) { const snapshot = guard.current.snapshot(); if (snapshot) drafts.current.set(selectedId, snapshot); } else drafts.current.delete(selectedId);
    applySwitch(target);
  };
  const goBack = () => requestSwitch('__back__');
  const onCreated = (created: Provider) => {
    client.setQueryData<Provider[]>(['providers'], previous => [...(previous || []).filter(provider => provider.id !== created.id), created]);
    applySwitch(created.id);
    // The first save of a provider discovers its models once; later name edits do not refetch.
    const revision = sessionRequestRevision();
    void client.fetchQuery({ queryKey: candidateKey(created), queryFn: () => fetchCandidates(created), staleTime: 0 }).then(async () => {
      if (revision === sessionRequestRevision()) await client.invalidateQueries({ queryKey: ['models'] });
    }).catch(() => {});
  };
  const onDeleted = (id: string) => {
    client.setQueryData<Provider[]>(['providers'], previous => (previous || []).filter(provider => provider.id !== id));
    setAdding(false); setMobileView('list'); navigate('/settings/providers');
  };
  return <div className="provider-workspace" data-view={mobileView}>
    <aside className="provider-list-pane" aria-label="供应商列表">
      <div className="provider-list-toolbar"><div className="provider-list-title"><h2>供应商</h2><span>{list.length}</span></div>
      <button className="primary-button" type="button" onClick={() => requestSwitch('new')}><Plus size={15} />添加供应商</button>
      <div className="model-search provider-search"><Search size={14} aria-hidden /><input aria-label="搜索供应商" placeholder="搜索供应商" value={providerFilter} onChange={event => setProviderFilter(event.target.value)} /></div></div>
      {providers.isPending && <p role="status">正在加载供应商…</p>}
      {providers.isError && <p role="alert" className="submit-error">{errorText(providers.error)}<button className="text-button" onClick={() => void providers.refetch()}>重试</button></p>}
      <nav className="provider-rows" aria-label="已添加供应商">
        {filteredProviders.map(provider => <button type="button" key={provider.id} className={`provider-row${selectedId === provider.id ? ' selected' : ''}`} aria-current={selectedId === provider.id ? 'true' : undefined} onClick={() => requestSwitch(provider.id)}>
          <span className="provider-avatar" aria-hidden>{provider.name.slice(0, 1)}</span><span className="provider-row-copy"><span className="provider-row-name">{provider.name}</span>
          <span className="provider-row-meta"><i className={provider.enabled ? 'enabled-dot' : ''} />{provider.enabled ? '已启用' : '已停用'}{provider.hasKey ? '' : ' · 未配置密钥'}</span></span>
        </button>)}
      </nav>
      {!!list.length && !filteredProviders.length && <p className="provider-search-empty">没有匹配的供应商</p>}
      {!providers.isPending && !providers.isError && !list.length && <p className="field-hint">还没有供应商，先添加一个。</p>}
    </aside>
    <main className="settings-main provider-detail-pane">
      {pendingSwitch && <section className="settings-card draft-guard" role="alertdialog" aria-label="未保存的修改">
        <h2>有未保存的修改</h2>
        <p>切换供应商前请选择处理方式；保留的草稿只存在于当前浏览器会话，切换账号会清空。</p>
        <div className="settings-card-actions">
          <button type="button" className="primary-button" onClick={() => resolveSwitch(true)}>保留草稿并切换</button>
          <button type="button" className="danger-button" onClick={() => resolveSwitch(false)}>放弃修改</button>
          <button type="button" className="secondary-button" onClick={() => setPendingSwitch(null)}>取消</button>
        </div>
      </section>}
      <div className="provider-detail">
        {notFound ? <section className="settings-empty"><h2>供应商不存在</h2><p>该供应商不存在或不属于当前账号。</p><button type="button" className="secondary-button" onClick={() => applySwitch('__back__')}>返回供应商列表</button></section>
          : adding ? <ProviderDetail key="new" isNew drafts={drafts} guard={guard} onCreated={onCreated} onCancelNew={() => applySwitch('__back__')} onDeleted={onDeleted} onBack={goBack} />
            : !selectedId ? <section className="settings-empty"><h2>还没有供应商</h2><p>先添加供应商，再拉取候选或手动添加模型。</p><button type="button" className="primary-button" onClick={() => requestSwitch('new')}><Plus size={15} />添加第一个供应商</button></section>
              : providers.isPending ? <p role="status">正在加载供应商…</p>
                : selectedProvider ? <ProviderDetail key={selectedProvider.id} provider={selectedProvider} isNew={false} drafts={drafts} guard={guard} onCreated={onCreated} onCancelNew={() => applySwitch('__back__')} onDeleted={onDeleted} onBack={goBack} />
                  : <p role="status">正在加载供应商…</p>}
      </div>
    </main>
  </div>;
}
