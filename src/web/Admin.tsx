import { t } from './i18n';
import { useEffect, useState } from 'react';
import { ShieldCheck, Users, KeyRound, History, ArrowLeft, Plus, Search, FolderOpen } from 'lucide-react';
import { api } from './state';
import { Modal } from './Modal';
import { permissionLabels } from '../shared/permissions';
import './admin.css';
import './management.css';

import type { Account, AdminData, RemovalTarget } from './adminTypes';
import { MemberEditor } from './AdminMembership';
import { AdminProjects } from './AdminProjects';
import { RemovalDialog } from './RemovalDialog';
type Audit = { id: number; actor: string; action: string; target: string; details: string; created: string };
const label = (scope: string) => t(permissionLabels[scope as keyof typeof permissionLabels] || scope);


export function Admin({ username }: { username: string }) {
    const [data, setData] = useState<AdminData | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
    const [tab, setTab] = useState('members'), [selected, setSelected] = useState(''), [query, setQuery] = useState(''), [audit, setAudit] = useState<Audit[]>([]), [more, setMore] = useState(true);
    const [removal, setRemoval] = useState<RemovalTarget | null>(null);
    const [dialog, setDialog] = useState<{ kind: 'create' | 'password' | 'account' | 'token'; user?: Account; tokenId?: string; title: string; administrator?: boolean; disabled?: boolean } | null>(null);
    const load = async () => { const result = await api('/admin'); setData(result); return result as AdminData; };
    const loadAudit = async (before?: number) => { const rows = await api('/admin/audit' + (before ? '?before=' + before : '')); setAudit(previous => before ? [...previous, ...rows] : rows); setMore(rows.length === 50); };
    useEffect(() => { void load().catch(error => setError(error.message)); }, []);
    useEffect(() => { if (tab === 'audit') void loadAudit().catch(error => setError(error.message)); }, [tab]);
    const save = async (path: string, body: unknown) => {
        setBusy(true); setError(''); setNotice('');
        try { const result = await api(path, body); if (path === '/admin/users') setSelected(result.id); setDialog(null); await load(); if (tab === 'audit') await loadAudit(); setNotice(t("已保存")); return true; }
        catch (error: any) { setError(error.message + (error.details ? t("：请检查输入及权限依赖。") : '')); return false; }
        finally { setBusy(false); }
    };
    const account = data?.users.find(user => user.id === selected) || data?.users[0];
    const userName = (id: string) => data?.users.find(user => user.id === id)?.username || id;
    const projectName = (id: string) => data?.projects.find(project => project.id === id)?.name || id;
    return <div className="admin-shell">
        <aside className="admin-nav"><div className="admin-brand"><ShieldCheck size={26}/><div><strong>{t("平台管理")}</strong><small>{t("账号、授权与安全记录")}</small></div></div><nav aria-label={t("管理导航")}>{[['members', t("账号管理"), Users], ['projects', t("项目管理"), FolderOpen], ['tokens', t("Agent 凭据"), KeyRound], ['audit', t("操作记录"), History]].map(([key, title, Icon]: any) => <button key={key} aria-current={tab === key ? 'page' : undefined} onClick={() => { setTab(key); setError(''); setNotice(''); }}><Icon size={17}/>{t(title)}</button>)}</nav><div className="admin-nav-bottom"><span>{username}{t("· 平台管理员")}</span><a href="/"><ArrowLeft size={15}/>{t("返回工作台")}</a><button onClick={() => void api('/logout', {}).then(() => location.reload()).catch(error => setError(error.message))}>{t("退出登录")}</button></div></aside>
        <main className="admin-main"><header className="admin-heading"><div><span className="eyebrow">{t("平台管理 /")} {tab === 'members' ? t("账号管理") : tab === 'projects' ? t("项目管理") : tab === 'tokens' ? t("Agent 凭据") : t("操作记录")}</span><h1>{tab === 'members' ? t("让每个人拥有合适的权限") : tab === 'projects' ? t("管理项目与团队协作") : tab === 'tokens' ? t("管理 Agent 的访问凭据") : t("每次管理操作，都有记录")}</h1><p>{t("管理权限不赋予草稿编辑或实现同步权限；这些能力需要按项目单独授权。")}</p></div>{tab === 'members' && <button className="primary" disabled={busy} onClick={() => setDialog({ kind: 'create', title: t("创建账号") })}><Plus size={16}/>{t("创建账号")}</button>}</header>
        {error && <p className="admin-feedback error-list" role="alert">{t(error)}<button disabled={busy} onClick={() => void load().then(() => setError('')).catch(error => setError(error.message))}>{t("重新加载")}</button></p>}{notice && <p className="admin-feedback" role="status">{t(notice)}</p>}
        {!data ? <p role="status">{error ? t("未能加载管理数据。") : t("正在加载…")}</p> : <>
        {tab === 'members' && <div className="admin-members"><section className="admin-roster" aria-label={t("账号列表")}><label className="admin-search"><Search size={16}/><input aria-label={t("搜索账号")} placeholder={t("搜索账号…")} value={query} onChange={event => setQuery(event.target.value)}/></label>{data.users.filter(user => user.username.toLowerCase().includes(query.toLowerCase())).map(user => <button className="admin-person" aria-pressed={account?.id === user.id} key={user.id} onClick={() => { setSelected(user.id); setNotice(''); }}><span className="avatar">{user.username.slice(0, 1)}</span><span><strong>{user.username}</strong><small>{user.disabled ? t("已停用") : user.administrator ? t("平台管理员") : t("通用账号")}</small></span></button>)}{!data.users.some(user => user.username.toLowerCase().includes(query.toLowerCase())) && <p>{t("没有匹配的账号")}</p>}</section>
        {account && <section className="admin-detail" aria-label={t("账号详情")}><header><div><h2>{account.username}</h2><p>{account.disabled ? t("已停用 · 草稿与历史仍保留") : t("正常使用")} · {account.administrator ? t("平台管理员") : t("通用账号")}</p></div><div className="admin-account-actions"><button disabled={busy} onClick={() => setDialog({ kind: 'password', user: account, title: t("重置 ") + account.username + ' 的密码' })}>{t("重置密码")}</button><button disabled={busy} onClick={() => setDialog({ kind: 'account', user: account, title: account.disabled ? '启用账号' : '停用账号', administrator: !!account.administrator, disabled: !account.disabled })}>{account.disabled ? t("启用账号") : t("停用账号")}</button><button disabled={busy} onClick={() => setDialog({ kind: 'account', user: account, title: account.administrator ? '收回平台管理权限' : '授予平台管理权限', administrator: !account.administrator, disabled: !!account.disabled })}>{account.administrator ? t("收回管理权限") : t("设为管理员")}</button><details className="admin-more"><summary>{t("更多操作")}</summary><div><button className="danger" disabled={busy} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); setRemoval({ kind: 'account', id: account.id }); }}>{t("删除账号")}</button></div></details></div></header>
        <h2 className="admin-subheading">{t("项目权限")}</h2><p className="muted">{t("只影响此账号的项目访问，不改变任何草稿或发布历史。清空权限可暂停项目访问。")}</p>{data.projects.map(project => { const member = data.members.find(member => member.userId === account.id && member.projectId === project.id); return <MemberEditor key={account.id + project.id + JSON.stringify(member?.scopes)} user={account} project={project} member={member} busy={busy} save={body => save('/admin/member', body)}/>; })}{!data.projects.length && <p>{t("尚无项目，请在项目管理中创建项目。")}</p>}</section>}</div>}
        {tab === 'projects' && <AdminProjects data={data} reload={async () => { await load(); }}/>}
        {tab === 'tokens' && <section className="admin-records"><p className="muted">{t("这里不显示密钥。撤销后立即失效，需要账号本人重新生成凭据。")}</p>{data.tokens.map(token => <article key={token.id}><div><h2>{token.name}</h2><p>{token.username} · {projectName(token.projectId)} · {new Date(token.created).toLocaleString()}</p><div className="admin-tags">{token.scopes.map(scope => <span key={scope}>{label(scope)}</span>)}{!token.scopes.length && <span>{t("无可用权限")}</span>}</div></div><button disabled={busy} onClick={() => setDialog({ kind: 'token', tokenId: token.id, title: t("撤销凭据：") + token.name })}>{t("撤销凭据")}</button></article>)}{!data.tokens.length && <p>{t("暂无 Agent 凭据。")}</p>}</section>}
        {tab === 'audit' && <section className="admin-records">{audit.map(record => { const details = JSON.parse(record.details); return <article key={record.id}><div><h2>{record.action} <span className="muted">· {details.name || userName(record.target)}</span></h2><p>{record.actor} · {new Date(record.created).toLocaleString()}</p>{details.projectId && <p>{t("项目：")}{projectName(details.projectId)}</p>}{details.after && <p>{t("原权限：")}{details.before.map(label).join('、') || t("无")}<br/>{t("调整为：")}{details.after.map(label).join('、') || t("无")}</p>}{details.administrator !== undefined && <p>{details.administrator ? t("平台管理员") : t("通用账号")} · {details.disabled ? t("已停用") : t("已启用")}</p>}{details.archived !== undefined && <p>{details.archived ? t("已归档 · 只读") : t("进行中")}</p>}{details.username && <p>{t("账号：")}{details.username}</p>}</div><small>#{record.id}</small></article>; })}{!audit.length && <p>{t("尚无管理操作记录。")}</p>}{more && <button disabled={busy} onClick={() => { setBusy(true); void loadAudit(audit.at(-1)?.id).catch(error => setError(error.message)).finally(() => setBusy(false)); }}>{t("加载更早记录")}</button>}</section>}
        </>}
        </main>
        {removal && <RemovalDialog target={removal} onClose={() => setRemoval(null)} onDone={async () => { await load(); setNotice(t('已保存')); }}/>}
        {dialog && <Modal title={dialog.title} busy={busy} onClose={() => setDialog(null)}><form onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); if (dialog.kind === 'create') void save('/admin/users', Object.fromEntries(form)); else if (dialog.kind === 'password') void save('/admin/password', { userId: dialog.user!.id, password: form.get('password') }); else if (dialog.kind === 'account') void save('/admin/account', { userId: dialog.user!.id, administrator: dialog.administrator, disabled: dialog.disabled, expected: { administrator: !!dialog.user!.administrator, disabled: !!dialog.user!.disabled } }); else void save('/admin/token/revoke', { id: dialog.tokenId }); }}>
            {dialog.kind === 'create' && <><p>{t("新账号默认没有项目权限。创建后请在项目权限中授权。")}</p><label>{t("账号名称")}<input name="username" required maxLength={80} autoComplete="off" autoFocus/></label></>}
            {(dialog.kind === 'create' || dialog.kind === 'password') && <label>{t("新密码（至少 10 个字符）")}<input name="password" type="password" autoComplete="new-password" required minLength={10} maxLength={1024}/></label>}
            {dialog.kind === 'password' && <p>{t("该账号的所有登录会话和 Agent 凭据会失效。草稿和历史保持不变。")}</p>}
            {dialog.kind === 'account' && <p>{t("目标账号：")}{dialog.user!.username}。{dialog.disabled ? t("停用后退出所有会话并撤销 Agent 凭据；不会删除草稿和历史。") : dialog.administrator ? t("此账号将能管理所有账号、项目成员权限和 Agent 凭据。") : t("账号不再拥有平台管理权限，项目权限保持不变。")}{t("必须保留至少一位可用管理员。")}</p>}
            {dialog.kind === 'token' && <p>{t("使用此凭据的 Agent 将无法继续访问。此操作不能撤销，可由所属账号重新创建凭据。")}</p>}
            {error && <p role="alert" className="error-list">{t(error)}</p>}<footer><button className="primary" disabled={busy}>{busy ? t("正在保存…") : t("确认")}</button></footer>
        </form></Modal>}
    </div>;
}
