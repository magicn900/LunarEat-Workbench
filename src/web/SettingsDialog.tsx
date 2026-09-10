import { useEffect, useState } from 'react';
import { KeyRound, Monitor, ShieldCheck, Copy, Plus, ChevronDown, Check, Keyboard } from 'lucide-react';
import { KeyboardSettings } from './KeyboardSettings';
import { Modal } from './Modal';
import { useAccount } from './accountContext';
import { api } from './state';
import { copyText } from './clipboard';
import { flushEditing } from './editing';
import { permissionDependencies, permissionLabels } from '../shared/permissions';
import { t, useLanguage } from './i18n';

type Connection = { scopes: string[]; tokens: { id: string; name: string; scopes: string; created: string }[] };
export function SettingsDialog({ onClose }: { onClose: () => void }) {
    const account = useAccount();
    const tabs = [['account', t('账号与安全'), ShieldCheck], ['general', t('通用'), Monitor], ['keyboard', t('快捷键'), Keyboard], ['agent', t('Agent 接入'), KeyRound]] as const;
    useLanguage();
    const [tab, setTab] = useState('account'), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
    const [passwords, setPasswords] = useState({ current: '', next: '', confirm: '' });
    const [connection, setConnection] = useState<Connection | null>(null), [loading, setLoading] = useState(false);
    const [creating, setCreating] = useState(false), [name, setName] = useState(''), [scopes, setScopes] = useState<string[]>([]), [token, setToken] = useState(''), [copied, setCopied] = useState(false);
    const [confirmation, setConfirmation] = useState<'close' | 'password' | { tokenId: string; name: string } | null>(null);
    const project = account.identity.projects.find(project => project.id === account.projectId);
    const dirty = Object.values(passwords).some(Boolean) || creating && (name.trim().length > 0 || scopes.length > 0);
    const unsavedSecret = !!token && !copied;
    const label = (scope: string) => t(permissionLabels[scope as keyof typeof permissionLabels] || scope);
    const loadConnection = async () => {
        if (!project) return;
        setLoading(true);
        try { const data = await api('/settings', undefined, project.id); setConnection(data); setScopes(previous => previous.filter(scope => data.scopes.includes(scope))); }
        catch (error: any) { setError(t(error.message)); }
        finally { setLoading(false); }
    };
    useEffect(() => { if (tab === 'agent') void loadConnection(); }, [tab, project?.id]);
    useEffect(() => {
        const prevent = (event: BeforeUnloadEvent) => { if (dirty || unsavedSecret) { event.preventDefault(); event.returnValue = ''; } };
        window.addEventListener('beforeunload', prevent);
        return () => window.removeEventListener('beforeunload', prevent);
    }, [dirty, unsavedSecret]);
    const close = () => { if (busy) return; if (dirty || unsavedSecret) setConfirmation('close'); else onClose(); };
    const perform = async (operation: () => Promise<void>) => { if (busy) return; setBusy(true); setError(''); setNotice(''); try { await operation(); } catch (error: any) { setError(t(error.message)); } finally { setBusy(false); } };
    const copy = async (value: string, secret = false) => { setError(''); setNotice(''); if (await copyText(value)) { if (secret) setCopied(true); setNotice(t('已复制')); } };
    const changePassword = () => void perform(async () => {
        await flushEditing();
        await api('/account/password', { currentPassword: passwords.current, newPassword: passwords.next });
        setPasswords({ current: '', next: '', confirm: '' }); setToken(''); setCreating(false); setConfirmation(null);
        await account.refreshIdentity(); onClose();
    });
    const confirmAction = () => {
        if (confirmation === 'close') { setPasswords({ current: '', next: '', confirm: '' }); setToken(''); onClose(); }
        else if (confirmation === 'password') changePassword();
        else if (confirmation) { const target = confirmation; void perform(async () => { await api('/tokens/revoke', { id: target.tokenId }, project?.id); setConfirmation(null); await loadConnection(); setNotice(t('凭据已撤销')); }); }
    };
    return <><Modal title={t('设置')} className="settings-dialog" busy={busy || !!confirmation} onClose={close}>
        <div className="settings-layout"><nav className="settings-tabs" role="tablist" aria-label={t('设置分类')}>{tabs.map(([key, title, Icon]: any) => <button type="button" role="tab" id={'settings-tab-' + key} aria-selected={tab === key} aria-controls={'settings-panel-' + key} tabIndex={tab === key ? 0 : -1} key={key} disabled={busy} onClick={() => { setTab(key); setError(''); setNotice(''); }} onKeyDown={event => { const keys: readonly string[] = tabs.map(item => item[0]); if (['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'account' : event.key === 'End' ? 'agent' : keys[(keys.indexOf(tab) + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : keys.length - 1)) % keys.length]; setTab(next); document.getElementById('settings-tab-' + next)?.focus(); } }}><Icon size={17}/><span>{t(title)}</span></button>)}</nav>
        <div className="settings-content">{error && <p role="alert" className="account-error">{error}</p>}{notice && <p role="status" className="settings-notice"><Check size={15}/>{notice}</p>}
            <section hidden={tab !== 'account'} role="tabpanel" id="settings-panel-account" aria-labelledby="settings-tab-account">
                <h2>{t('账号与安全')}</h2><p className="settings-description">{t('管理你自己的账号，不改变项目内容。')}</p>
                <dl className="settings-identity"><dt>{t('当前账号')}</dt><dd>{account.identity.username}</dd><dt>{t('当前项目')}</dt><dd>{project?.name || t('尚未加入项目')}</dd></dl>
                {project && <details className="settings-details"><summary>{t('查看我的项目权限')}<ChevronDown size={15}/></summary><ul>{project.scopes.map(scope => <li key={scope}>{label(scope)}</li>)}{!project.scopes.length && <li>{t('暂无项目内容权限')}</li>}</ul></details>}
                <form className="settings-form" onSubmit={event => { event.preventDefault(); setError(''); if (passwords.next !== passwords.confirm) { setError(t('两次输入的新密码不一致')); return; } setConfirmation('password'); }}>
                    <h3>{t('修改密码')}</h3><p>{t('需要验证当前密码。修改成功后重新登录，所有旧登录和 Agent 凭据都会失效。')}</p>
                    <fieldset disabled={busy}><label>{t('当前密码')}<input name="currentPassword" type="password" autoComplete="current-password" required value={passwords.current} onChange={event => setPasswords({ ...passwords, current: event.target.value })}/></label><label>{t('新密码')}<input name="newPassword" type="password" autoComplete="new-password" required minLength={10} maxLength={1024} value={passwords.next} onChange={event => setPasswords({ ...passwords, next: event.target.value })}/><small>{t('至少 10 个字符')}</small></label><label>{t('确认新密码')}<input name="confirmPassword" type="password" autoComplete="new-password" required value={passwords.confirm} onChange={event => setPasswords({ ...passwords, confirm: event.target.value })}/></label><button className="primary" disabled={busy}>{t('修改密码')}</button></fieldset>
                </form>
            </section>
            <section hidden={tab !== 'general'} role="tabpanel" id="settings-panel-general" aria-labelledby="settings-tab-general">
                <h2>{t('通用')}</h2><p className="settings-description">{t('偏好随账号保存，切换项目不会重置，也不纳入策划版本。')}</p>
                <fieldset className="settings-theme" disabled={busy}><legend>{t('主题')}</legend><div className="theme-options">{[['light', t("浅色")], ['dark', t("深色")], ['system', t("跟随系统")]].map(([value, title]) => <label key={value} className={'theme-option theme-' + value}><input type="radio" name="theme" value={value} checked={account.preferences.theme === value} onChange={() => void perform(() => account.savePreferences({ ...account.preferences, theme: value as 'light' | 'dark' | 'system' }))}/><span className="theme-preview" aria-hidden="true"><i/><b/><b/></span><span>{t(title)}</span></label>)}</div></fieldset>
                <label className="settings-language">{t('界面语言')}<select aria-label={t('界面语言')} disabled={busy} value={account.preferences.language} onChange={event => void perform(() => account.savePreferences({ ...account.preferences, language: event.target.value as 'zh-CN' | 'en' }))}><option value="zh-CN">{t("简体中文")}</option><option value="en">English</option></select></label><p className="settings-description">{t('只切换界面文字，不翻译策划正文、字段和自定义名称。')}</p>
                <p className="settings-description" role="status">{busy ? t('正在保存…') : t('选择后自动保存')}</p>
            </section>
            <section hidden={tab !== 'keyboard'} role="tabpanel" id="settings-panel-keyboard" aria-labelledby="settings-tab-keyboard"><KeyboardSettings/></section>
            <section hidden={tab !== 'agent'} role="tabpanel" id="settings-panel-agent" aria-labelledby="settings-tab-agent">
                <h2>{t('Agent 接入')}</h2><p className="settings-description">{t('Agent 使用你的身份，只能访问你明确授予的当前项目能力。')}</p>
                {!project ? <p>{t('加入项目后即可创建 Agent 凭据。')}</p> : <>{loading && !connection ? <p role="status">{t('正在加载…')}</p> : !connection ? <button onClick={() => void loadConnection()}>{t('重试')}</button> : <>
                    <AgentConnection projectName={project.name} copy={copy}/>
                    <div className="settings-section-heading"><h3>{t('已有凭据')}</h3><button disabled={busy || creating} onClick={() => { if (unsavedSecret) { setError(t('请先保存刚生成的密钥')); return; } setToken(''); setName(''); setScopes([]); setCreating(true); }}><Plus size={15}/>{t('创建凭据')}</button></div>
                    <div className="settings-tokens">{connection.tokens.map(item => <article key={item.id}><div><strong>{item.name}</strong><small>{new Date(item.created).toLocaleString(account.preferences.language)}</small><p>{(JSON.parse(item.scopes) as string[]).map(label).join(' · ') || t('无可用权限')}</p></div><button disabled={busy} onClick={() => setConfirmation({ tokenId: item.id, name: item.name })}>{t('撤销凭据')}</button></article>)}{!connection.tokens.length && <p className="settings-empty">{t('还没有凭据。创建一个，让 Agent 加入协作。')}</p>}</div>
                    {creating && <form className="settings-token-form" onSubmit={event => { event.preventDefault(); void perform(async () => { const result = await api('/tokens', { name: name.trim(), scopes }, project.id); setToken(result.token); setCopied(false); setCreating(false); setName(''); setScopes([]); await loadConnection(); }); }}><h3>{t('创建 Agent 凭据')}</h3><fieldset disabled={busy}><label>{t('凭据名称')}<input value={name} maxLength={100} required placeholder={t('例如：我的 coding agent')} onChange={event => setName(event.target.value)}/></label><p>{t('允许 Agent 做什么')}</p><div className="settings-scopes">{connection.scopes.filter(scope => project.scopes.includes(scope)).map(scope => <label key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={event => setScopes(event.target.checked ? [...new Set([...scopes, scope, ...(permissionDependencies[scope] || []).filter(required => connection.scopes.includes(required))])] : scopes.filter(item => item !== scope && !(permissionDependencies[item] || []).includes(scope)))}/><span>{label(scope)}<small>{scope}</small></span></label>)}</div><footer><button type="button" onClick={() => { setCreating(false); setName(''); setScopes([]); }}>{t('取消')}</button><button className="primary" disabled={busy || !name.trim() || !scopes.length}>{t('生成凭据')}</button></footer></fieldset></form>}
                    {token && <div className="settings-secret"><strong>{t('仅显示一次，请妥善保管')}</strong><code>{token}</code><button onClick={() => void copy(token, true)}><Copy size={15}/>{copied ? t('已复制') : t('复制密钥')}</button></div>}
                </>}</>}
            </section>
        </div></div>
    </Modal>{confirmation && <Modal title={t(confirmation === 'close' ? t("关闭设置？") : confirmation === 'password' ? t("确认修改密码？") : t("撤销凭据？"))} busy={busy} onClose={() => setConfirmation(null)}>
        {confirmation === 'close' ? <p>{t(unsavedSecret ? t("刚生成的密钥尚未复制，关闭后无法再次查看。") : t("有尚未提交的输入，关闭后将放弃这些输入。"))}</p> : confirmation === 'password' ? <p>{t('将先保存已有草稿，然后退出所有登录并撤销全部 Agent 凭据。请确认继续。')}</p> : <p>{confirmation.name} — {t('撤销后立即失效，不能撤销此操作。')}</p>}
        {error && <p className="account-error" role="alert">{error}</p>}<div className="settings-confirm-actions"><button disabled={busy} onClick={() => setConfirmation(null)}>{t('返回')}</button><button className="primary" disabled={busy} onClick={confirmAction}>{t(confirmation === 'close' ? t("放弃并关闭") : confirmation === 'password' ? t("确认修改并重新登录") : t("确认撤销"))}</button></div>
    </Modal>}</>;
}
import { AgentConnection } from './AgentConnection.js';
