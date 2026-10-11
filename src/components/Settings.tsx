import { useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Search } from 'lucide-react';
import { accountApi } from '../core/api';
import { errorText } from '../core/errors';
import { UserMenu, useAuth } from './Auth';
import { ConfirmDelete, Feedback, ProviderWorkspace, useAction } from './ProviderWorkspace';

/** Global model summary: cross-provider default preference and filtering, without a second provider choice. */
function Models() {
  const client = useQueryClient(); const action = useAction();
  const models = useQuery({ queryKey: ['models'], queryFn: accountApi.models });
  const providers = useQuery({ queryKey: ['providers'], queryFn: accountApi.providers });
  const preferences = useQuery({ queryKey: ['preferences'], queryFn: accountApi.preferences });
  const [filter, setFilter] = useState('');
  const invalidate = async () => { await Promise.all([client.invalidateQueries({ queryKey: ['models'] }), client.invalidateQueries({ queryKey: ['preferences'] })]); };
  const all = models.data || [];
  const providerOf = (id: string) => providers.data?.find(provider => provider.id === id);
  const defaultId = preferences.data?.defaultModelId;
  const defaultModel = all.find(model => model.id === defaultId);
  const notice = preferences.data === undefined ? '' : !defaultId ? '尚未设置默认模型：在聊天输入框明确选择可用模型后才能发送。'
    : !defaultModel ? '默认模型已被删除，请在聊天输入框明确选择其他模型，不会自动替换。'
      : !defaultModel.enabled || !providerOf(defaultModel.providerId)?.enabled ? '默认模型或其供应商已停用，请在聊天输入框明确选择其他模型，不会自动替换。' : '';
  const needle = filter.trim().toLowerCase();
  const visible = all.filter(model => !needle || model.name.toLowerCase().includes(needle) || model.modelId.toLowerCase().includes(needle));
  return <><div className="settings-section-title"><div><h1>模型</h1><p>跨供应商汇总已添加模型并设置默认模型；添加、拉取与参数编辑在供应商工作区完成。</p></div></div>
    {notice && <p className="settings-notice" role="status">{notice}</p>}
    <div className="model-search"><Search size={14} strokeWidth={1.4} aria-hidden /><input aria-label="搜索模型" placeholder="搜索模型" value={filter} onChange={event => setFilter(event.target.value)} /></div>
    <Feedback {...action} />
    {providers.isError && <p role="alert" className="submit-error">{errorText(providers.error)}</p>}
    {models.isPending ? <p role="status">正在加载模型…</p> : models.isError ? <p className="submit-error" role="alert">{errorText(models.error)}<button className="text-button" onClick={() => void models.refetch()}>重试</button></p> : <div className="settings-list">
      {!visible.length && <div className="settings-empty"><h2>还没有模型</h2><p>在<Link className="inline-link" to="/settings/providers">供应商工作区</Link>拉取候选或手动添加模型。</p></div>}
      {visible.map(model => { const provider = providerOf(model.providerId); return <article className="settings-card" key={model.id}>
        <div className="settings-card-heading"><div><h2>{model.name}</h2><p>{provider?.name || '已删除的供应商'} · {model.enabled ? '已启用' : '已停用'}</p></div>{preferences.data?.defaultModelId === model.id && <span className="status-pill">默认模型</span>}</div>
        <p className="provider-url">{model.modelId}</p>
        <p className="field-hint">{model.capabilities.known ? `${model.capabilities.family} · 输出上限 ${model.maxOutputTokens} tokens` : '思考能力未核实 · 普通文本请求'}</p>
        <div className="settings-card-actions"><button className="secondary-button" disabled={action.pending || !model.enabled || !provider?.enabled || preferences.data?.defaultModelId === model.id} onClick={() => void action.run(async () => { await accountApi.savePreferences(model.id); await invalidate(); }, '默认模型已保存。')}>设为默认</button><ConfirmDelete title={model.name} remove={async () => { await accountApi.removeModel(model.id); await invalidate(); }}>删除后无法使用此模型发送新消息，历史仍然保留。</ConfirmDelete></div>
      </article>; })}
    </div>}
  </>;
}

function Account() {
  const auth = useAuth(); const action = useAction();
  return <><div className="settings-section-title"><div><h1>账号</h1><p>管理登录密码与当前会话。</p></div></div><section className="settings-card"><h2>登录信息</h2><p className="account-name">用户名：{auth?.user.username}</p></section><section className="settings-card"><h2>修改密码</h2><p>修改成功后会注销所有设备的会话，请重新登录。</p><form className="settings-form account-form" onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); void action.run(async () => { if (String(data.get('newPassword')).length < 12) throw new Error('新密码至少 12 个字符。'); if (data.get('newPassword') !== data.get('confirmPassword')) throw new Error('两次输入的新密码不一致。'); await accountApi.password(String(data.get('currentPassword')), String(data.get('newPassword'))); auth?.expire(); }); }}><fieldset disabled={action.pending}><label>当前密码<input name="currentPassword" type="password" autoComplete="current-password" required /></label><p className="field-hint">新密码至少 12 个字符，服务端上限为 128 字节。</p><label>新密码<input name="newPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={128} /></label><label>确认新密码<input name="confirmPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={128} /></label></fieldset><Feedback {...action} /><button className="primary-button" disabled={action.pending}>{action.pending ? '保存中…' : '修改密码'}</button></form></section></>;
}

export function Settings() {
  const { pathname } = useLocation();
  const section = pathname.split('/')[2] || 'providers';
  return <div className="settings-shell"><aside className="settings-nav"><Link className="settings-back" to="/"><ArrowLeft size={16} />返回聊天</Link><h2>设置</h2><nav aria-label="设置分类"><NavLink to="/settings/providers">供应商</NavLink><NavLink to="/settings/models">模型</NavLink><NavLink to="/settings/account">账号</NavLink></nav><UserMenu /></aside>
    {section === 'models' || section === 'account' ? <main className="settings-main"><div className="settings-content">{section === 'models' ? <Models /> : <Account />}</div></main> : <ProviderWorkspace />}
  </div>;
}
