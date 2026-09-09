import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { api } from './state';
import { t } from './i18n';
import type { RemovalTarget, RemovalImpact } from './adminTypes';

export function RemovalDialog({ target, onClose, onDone }: { target: RemovalTarget; onClose: () => void; onDone: () => Promise<void> }) {
    const [impact, setImpact] = useState<RemovalImpact | null>(null), [confirmation, setConfirmation] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
    const title = target.kind === 'account' ? t('删除账号') : target.kind === 'project' ? t('删除项目') : t('移出项目');
    const load = async () => { setBusy(true); setImpact(null); setError(''); setConfirmation(''); try { setImpact(await api('/admin/impact?' + new URLSearchParams(target))); } catch (error: any) { setError(error.message); } finally { setBusy(false); } };
    useEffect(() => { void load(); }, [target.kind, target.id, target.projectId]);
    const remove = async () => {
        if (!impact || busy) return;
        setBusy(true); setError('');
        try { await api('/admin/remove', { ...target, name: confirmation, expected: impact.expected }); await onDone(); onClose(); }
        catch (error: any) { setError(error.message); }
        finally { setBusy(false); }
    };
    return <Modal title={title} busy={busy} onClose={onClose} className="removal-dialog"><form onSubmit={event => { event.preventDefault(); void remove(); }}>
        {impact ? <><p><strong>{impact.name}</strong></p><p className="muted">{target.kind === 'account' ? t('账号将从列表移除，登录和 Agent 凭据失效。已发布设计、共享灵感及历史署名保留，账号名称不再复用。') : target.kind === 'project' ? t('项目将从平台移除，所有成员和 Agent 失去访问，网页不能撤销此操作。底层数据保留用于备份恢复，不做物理擦除。') : t('此账号将失去该项目的访问权限，相关 Agent 凭据失效；个人草稿与历史保留，重新加入后可继续。')}</p>
        {target.kind !== 'project' && impact.projects.length > 0 && <div className="removal-projects"><strong>{t('关联项目')}</strong><ul>{impact.projects.map(project => <li key={project.id}>{project.name}</li>)}</ul></div>}<dl className="removal-counts"><dt>{t('关联成员关系')}</dt><dd>{impact.counts.members}</dd><dt>{t('个人工作区数量')}</dt><dd>{impact.counts.workspaces}</dd><dt>{t('未发布草稿数量')}</dt><dd>{impact.counts.unpublished}</dd><dt>{t('Agent 凭据')}</dt><dd>{impact.counts.tokens}</dd>{target.kind === 'project' && <><dt>{t('正式版本数量')}</dt><dd>{impact.counts.revisions}</dd><dt>{t('共享便签数量')}</dt><dd>{impact.counts.notes}</dd></>}</dl>
        {impact.blockers.length > 0 ? <div className="error-list" role="status"><strong>{t('暂时不能执行')}</strong><ul>{impact.blockers.map(blocker => <li key={blocker}>{t(blocker)}</li>)}</ul>{impact.drafts.length > 0 && <p>{t('未发布草稿所在项目：')}{[...new Set(impact.drafts.map(draft => draft.projectName))].join('、')}</p>}</div> : <label>{t('输入名称以确认')}<input autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)} required disabled={busy}/></label>}</> : <p role="status">{busy ? t('正在读取影响范围…') : t('未能读取影响范围')}</p>}
        {error && <p role="alert" className="error-list">{t(error)}</p>}
        <footer><button type="button" disabled={busy} onClick={() => void load()}>{t('重新查看影响范围')}</button><button type="button" disabled={busy} onClick={onClose}>{t('取消')}</button><button className="danger" disabled={busy || !impact || impact.blockers.length > 0 || confirmation !== impact.name}>{title}</button></footer>
    </form></Modal>;
}
