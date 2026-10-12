import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { ChevronDown, UserRound } from 'lucide-react';
import { accountApi, invalidateSessionRequests, sessionRequestRevision } from '../core/api';
import { ApiError, errorText } from '../core/errors';
import { clearPrivateUI } from '../core/ui-store';
import type { User } from '../core/types';
import { Mark } from './Brand';

const AuthContext = createContext<{ user: User; logout: () => Promise<void>; expire: () => void } | null>(null);
export const useAuth = () => useContext(AuthContext);
export function AuthBoundary({ children }: { children: ReactNode }) {
  const client = useQueryClient(); const navigate = useNavigate();
  const [user, setUser] = useState<User>(); const [checking, setChecking] = useState(true); const [error, setError] = useState(''); const [registration, setRegistration] = useState(false); const [pending, setPending] = useState(false);
  useEffect(() => {
    let active = true;
    const revision = sessionRequestRevision();
    const expire = () => { window.dispatchEvent(new Event('closewebui:session-end')); invalidateSessionRequests(); client.clear(); clearPrivateUI(); setUser(undefined); setChecking(false); setRegistration(false); setError(''); navigate('/', { replace: true }); };
    window.addEventListener('closewebui:unauthorized', expire);
    void accountApi.me().then(value => { if (active && revision === sessionRequestRevision()) setUser(value); }).catch(e => { if (active && revision === sessionRequestRevision() && !(e instanceof ApiError && e.status === 401)) setError(errorText(e)); }).finally(() => { if (active) setChecking(false); });
    return () => { active = false; window.removeEventListener('closewebui:unauthorized', expire); };
  }, [client, navigate]);
  const ownerRevision = sessionRequestRevision();
  const expire = () => { if (ownerRevision === sessionRequestRevision()) window.dispatchEvent(new Event('closewebui:unauthorized')); };
  const logout = async () => { await accountApi.logout(); expire(); };
  if (checking) return <div className="recovery" role="status">正在恢复会话…</div>;
  if (user) return <AuthContext.Provider value={{ user, logout, expire }}>{children}</AuthContext.Provider>;
  return <main className="auth-page"><form className="auth-card" onSubmit={async e => {
    e.preventDefault(); if (pending) return; const data = new FormData(e.currentTarget); setPending(true); setError('');
    try { const username = String(data.get('username')).trim(); const password = String(data.get('password')); if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) throw new Error('用户名须为 3–32 个英文字母、数字、下划线或连字符。'); if (password.length < 12) throw new Error('密码至少 12 个字符。'); const value = await accountApi[registration ? 'register' : 'login'](username, password); invalidateSessionRequests(); client.clear(); clearPrivateUI(); setUser(value); }
    catch (e) { setError(errorText(e)); } finally { setPending(false); }
  }}><Link to="/" className="auth-brand"><Mark /><span>CloseWebUI</span></Link><h1>{registration ? '创建 CloseWebUI 账号' : '登录 CloseWebUI'}</h1><p>保存你的对话，连接自己的模型。</p><label>用户名<input aria-describedby="username-hint" name="username" autoComplete="username" required minLength={3} maxLength={32} pattern="[A-Za-z0-9_\-]{3,32}" disabled={pending} /></label><small id="username-hint" className="field-hint">3–32 个英文字母、数字、下划线或连字符，大小写不区分。</small><label>密码<input name="password" type="password" autoComplete={registration ? 'new-password' : 'current-password'} required minLength={12} maxLength={128} disabled={pending} /></label>{registration && <p className="field-hint">密码至少 12 个字符，服务端上限为 128 字节。</p>}{error && <p role="alert" className="submit-error">{error}</p>}<button className="primary-button" disabled={pending}>{pending ? '请稍候…' : registration ? '注册并登录' : '登录'}</button><button type="button" className="text-button" disabled={pending} onClick={() => { setRegistration(!registration); setError(''); }}>{registration ? '已有账号？登录' : '没有账号？注册'}</button></form></main>;
}

function AccountMenuSeparator({ close }: { close: () => void }) {
  const separator = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = separator.current;
    if (!node) return;
    const menu = node.parentElement;
    if (!menu) return;
    // Chromium can retarget a thin separator's tap to the adjacent action.
    // Inspect the physical coordinates at the common menu ancestor so the
    // guard also runs when the separator itself receives no touch event.
    const preventCompatibilityClick = (event: TouchEvent) => {
      const touch = event.touches[0];
      const box = node.getBoundingClientRect();
      if (!touch) return;
      const bounds = menu.getBoundingClientRect();
      if (touch.clientX < bounds.left || touch.clientX > bounds.right || touch.clientY < bounds.top || touch.clientY > bounds.bottom) { event.preventDefault(); close(); }
      else if (touch.clientX >= box.left && touch.clientX <= box.right && touch.clientY >= box.top && touch.clientY <= box.bottom) event.preventDefault();
    };
    menu.addEventListener('touchstart', preventCompatibilityClick, { passive: false, capture: true });
    return () => menu.removeEventListener('touchstart', preventCompatibilityClick, { capture: true });
  }, [close]);
  return <Dropdown.Separator ref={separator} className="model-separator" />;
}

export function UserMenu() {
  const auth = useAuth(); const [error, setError] = useState(''); const [pending, setPending] = useState(false); const [open, setOpen] = useState(false);
  if (!auth) return null;
  return <div className="user-menu-wrap"><Dropdown.Root open={open} onOpenChange={setOpen}><Dropdown.Trigger asChild><button className="user-menu-trigger" aria-label={`账户菜单：${auth.user.username}`}><span className="user-avatar"><UserRound size={16} /></span><span className="user-name">{auth.user.username}</span><ChevronDown size={14} /></button></Dropdown.Trigger><Dropdown.Portal><Dropdown.Content className="dropdown" align="start" sideOffset={8}><Dropdown.Item asChild><Link to="/settings/providers">设置</Link></Dropdown.Item><AccountMenuSeparator close={() => setOpen(false)} /><Dropdown.Item disabled={pending} onSelect={e => { e.preventDefault(); setPending(true); void auth.logout().catch(e => setError(errorText(e))).finally(() => setPending(false)); }}>{pending ? '正在退出…' : '退出登录'}</Dropdown.Item></Dropdown.Content></Dropdown.Portal></Dropdown.Root>{error && <p role="alert" className="submit-error">{error}</p>}</div>;
}
