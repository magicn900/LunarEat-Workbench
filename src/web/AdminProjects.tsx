import { useState } from 'react';
import { Archive, FolderOpen, Plus, Search } from 'lucide-react';
import { t } from './i18n';
import { api } from './state';
import { Modal } from './Modal';
import { MemberEditor } from './AdminMembership';
import { RemovalDialog } from './RemovalDialog';
import type { AdminData, RemovalTarget } from './adminTypes';
import './management.css';

export function AdminProjects({ data, reload }: { data: AdminData; reload: () => Promise<void> }) {
    const [selected, setSelected] = useState(''), [query, setQuery] = useState(''), [filter, setFilter] = useState('active'), [tab, setTab] = useState('overview'), [userId, setUserId] = useState('');
    const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [name, setName] = useState('');
    const [dialog, setDialog] = useState<{ action: 'create' | 'rename' | 'archive' | 'restore'; project?: AdminData['projects'][number] } | null>(null);
    const [removal, setRemoval] = useState<RemovalTarget | null>(null);
    const projects = data.projects.filter(project => (filter === 'all' || !!project.archived === (filter === 'archived')) && (project.name + ' ' + project.id).toLowerCase().includes(query.toLowerCase()));
    const project = projects.find(project => project.id === selected) || projects[0];
    const members = data.members.filter(member => member.projectId === project?.id);
    const user = data.users.find(user => user.id === userId) || data.users.find(user => members.some(member => member.userId === user.id)) || data.users[0];
    const member = members.find(member => member.userId === user?.id);
    const saveMember = async (body: unknown) => {
        setBusy(true); setError(''); setNotice('');
        try { await api('/admin/member', body); await reload(); setNotice('已保存'); return true; }
        catch (error: any) { setError(error.message); return false; }
        finally { setBusy(false); }
    };
    const submit = async () => {
        if (!dialog || busy) return;
        setBusy(true); setError('');
        try {
            if (dialog.action === 'create') { const created = await api('/admin/projects', { name }); setSelected(created.id); setFilter('active'); setQuery(''); setTab('members'); setNotice('项目已创建，请添加成员；管理权限不会自动授予项目访问。'); }
            else { await api('/admin/project', { id: dialog.project!.id, version: dialog.project!.version, action: dialog.action, ...(dialog.action === 'rename' ? { name } : {}) }); setFilter('all'); setNotice('已保存'); }
            setDialog(null); await reload();
        } catch (error: any) { setError(error.message); }
        finally { setBusy(false); }
    };
    const dialogTitle = dialog?.action === 'create' ? t('创建项目') : dialog?.action === 'rename' ? t('重命名项目') : dialog?.action === 'archive' ? t('归档项目') : t('恢复项目');
    return <section className="project-manager">
        <div className="project-toolbar"><label><Search size={16}/><input aria-label={t('搜索项目')} placeholder={t('搜索项目')} value={query} onChange={event => setQuery(event.target.value)}/></label><select aria-label={t('项目状态筛选')} value={filter} onChange={event => setFilter(event.target.value)}><option value="active">{t('进行中')}</option><option value="archived">{t('已归档')}</option><option value="all">{t('全部项目')}</option></select><button className="primary" disabled={busy} onClick={() => { setName(''); setError(''); setDialog({ action: 'create' }); }}><Plus size={16}/>{t('创建项目')}</button></div>
        {error && !dialog && <p role="alert" className="error-list">{t(error)}</p>}{notice && <p role="status" className="admin-feedback">{t(notice)}</p>}
        <div className="admin-grid"><div className="admin-users project-list" aria-label={t('项目列表')}>{projects.map(item => <button key={item.id} aria-current={item.id === project?.id ? 'true' : undefined} onClick={() => { setSelected(item.id); setUserId(''); setError(''); }}><FolderOpen size={18}/><span><strong>{item.name}</strong><small>{item.archived ? t('已归档') : t('进行中')}</small></span></button>)}{!projects.length && <p className="muted">{t('没有匹配的项目，可创建项目或调整筛选。')}</p>}</div>
        {project && <section className="admin-detail project-detail"><header><div><h2>{project.name}</h2><span className="admin-badge">{project.archived ? t('已归档 · 只读') : t('进行中')}</span></div></header><nav className="project-tabs" aria-label={t('项目详情分类')}>{[['overview', t('概览')], ['members', t('成员与权限')], ['danger', t('危险操作')]].map(([key, title]) => <button key={key} aria-current={tab === key ? 'page' : undefined} onClick={() => setTab(key)}>{title}</button>)}</nav>
            {tab === 'overview' && <div className="project-overview"><h3>{t('项目概览')}</h3><dl className="removal-counts"><dt>{t('项目名称')}</dt><dd>{project.name}</dd><dt>{t('项目标识')}</dt><dd className="mono">{project.id}</dd><dt>{t('项目成员')}</dt><dd>{members.length}</dd></dl><p className="muted">{t('管理员可以管理项目，不因此获得策划内容权限。请在成员与权限中明确授权。')}</p><button disabled={busy} onClick={() => { setName(project.name); setError(''); setDialog({ action: 'rename', project }); }}>{t('重命名项目')}</button>{!!project.archived && <p className="muted">{t('归档期间保留原授权，但人工和 Agent 都不能写入；恢复项目后原授权重新生效。')}</p>}</div>}
            {tab === 'members' && <div className="project-members"><p className="muted">{t('选择账号后添加成员或调整权限。移出项目与清空权限不同，个人草稿仍会保留。')}</p><label>{t('选择账号')}<select value={user?.id || ''} onChange={event => setUserId(event.target.value)}>{data.users.map(account => <option key={account.id} value={account.id}>{account.username}{members.some(member => member.userId === account.id) ? ' · ' + t('项目成员') : ''}{account.disabled ? ' · ' + t('已停用') : ''}</option>)}</select></label>{user && <><MemberEditor key={project.id + user.id + JSON.stringify(member)} project={project} user={user} heading={user.username} member={member} save={saveMember} busy={busy}/>{member && <button className="danger" disabled={busy} onClick={() => setRemoval({ kind: 'member', id: user.id, projectId: project.id })}>{t('移出项目')}</button>}</>}</div>}
            {tab === 'danger' && <div className="project-danger"><h3><Archive size={18}/>{project.archived ? t('恢复项目') : t('归档项目')}</h3><p>{t('归档保留所有内容并暂停写入，可随时恢复。存在活动写入或未保存输入时不能归档。')}</p><button disabled={busy} onClick={() => { setError(''); setDialog({ action: project.archived ? 'restore' : 'archive', project }); }}>{project.archived ? t('恢复项目') : t('归档项目')}</button><hr/><h3>{t('删除项目')}</h3><p>{t('删除会移除项目访问和相关 Agent 凭据。请先归档，再查看影响范围并输入项目名称确认。')}</p><button className="danger" disabled={busy} onClick={() => setRemoval({ kind: 'project', id: project.id })}>{t('查看删除影响')}</button></div>}
        </section>}</div>
        {dialog && <Modal title={dialogTitle} busy={busy} onClose={() => setDialog(null)}><form onSubmit={event => { event.preventDefault(); void submit(); }}>{dialog.action === 'create' || dialog.action === 'rename' ? <label>{t('项目名称')}<input required maxLength={120} value={name} onChange={event => setName(event.target.value)} autoFocus/></label> : <p>{dialog.project?.name}：{t('归档期间保留原授权，但人工和 Agent 都不能写入；恢复项目后原授权重新生效。')}</p>}{error && <p role="alert" className="error-list">{t(error)}</p>}<footer><button type="button" disabled={busy} onClick={() => setDialog(null)}>{t('取消')}</button><button className="primary" disabled={busy}>{t('确认')}</button></footer></form></Modal>}
        {removal && <RemovalDialog target={removal} onClose={() => setRemoval(null)} onDone={async () => { await reload(); setNotice('已保存'); }}/>}
    </section>;
}
