import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarDays, ChartNoAxesGantt, ChevronLeft, ChevronRight, GitBranch, Plus, RefreshCw, UserRound } from 'lucide-react';
import { ancestors, dateNumber, dateString, dateWarnings, descendants, emptyTask, localToday, taskStatuses, type ScheduledTask, type ScheduleSnapshot, type TaskFields } from '../shared/schedule';
import { useAccount } from './accountContext';
import { api, notify } from './state';
import { Modal } from './Modal';
import { editingChanged, registerBuffer } from './editing';
import { randomUUID } from './uuid';
import { t } from './i18n';
import { ScheduleTimeline } from './ScheduleTimeline';
import './schedule.css';

type Editor = { original: ScheduledTask | null; fields: TaskFields };
const fieldsOf = ({ title, description, acceptance, parentId, ownerIds, startDate, endDate, status, blockedReason }: TaskFields): TaskFields => ({ title, description, acceptance, parentId, ownerIds, startDate, endDate, status, blockedReason });

export function Schedule() {
    const { identity, projectId } = useAccount();
    const [data, setData] = useState<ScheduleSnapshot | null>(null), [error, setError] = useState('');
    const [refreshing, setRefreshing] = useState(false), [view, setView] = useState<'people' | 'tree'>('people');
    const [mine, setMine] = useState(false), [scope, setScope] = useState('');
    const [rescheduling, setRescheduling] = useState(false);
    const [start, setStart] = useState(() => dateNumber(localToday())), [days, setDays] = useState(14);
    const [editor, setEditor] = useState<Editor | null>(null), [busy, setBusy] = useState(false), [saveError, setSaveError] = useState('');
    const mounted = useRef(false), generation = useRef(0), sending = useRef(false);
    const lastRequest = useRef<{ signature: string; requestId: string } | null>(null);
    const tasks = data?.tasks || [], members = data?.members || [];
    const manage = !!data?.scopes.includes('schedule.manage');
    const canUpdate = manage || !!(data?.scopes.includes('schedule.update') && editor?.original?.ownerIds.includes(identity.id));
    const dirty = !!editor && JSON.stringify(editor.fields) !== JSON.stringify(fieldsOf(editor.original || emptyTask));
    const load = useCallback(async (quiet = false) => {
        const current = ++generation.current;
        if (!quiet) setRefreshing(true);
        try {
            const next: ScheduleSnapshot = await api('/schedule', undefined, projectId);
            if (mounted.current && current === generation.current) { setData(next); setError(''); }
        } catch (failure: any) {
            if (mounted.current && current === generation.current) {
                setError(failure.message);
                if (failure.status === 401 || failure.status === 403) setData(null);
            }
        } finally { if (mounted.current && current === generation.current) setRefreshing(false); }
    }, [projectId]);
    useEffect(() => {
        mounted.current = true; void load();
        const refresh = () => { if (!document.hidden) void load(true); };
        const timer = window.setInterval(refresh, 15000);
        window.addEventListener('focus', refresh);
        return () => { mounted.current = false; generation.current++; clearInterval(timer); window.removeEventListener('focus', refresh); };
    }, [load]);
    useEffect(() => {
        const unregister = registerBuffer('schedule-editor', { dirty: () => dirty || busy || rescheduling, flush: async () => { if (dirty || busy || rescheduling) throw Error(t('请先保存或关闭任务编辑')); } });
        const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty || busy || rescheduling) { event.preventDefault(); event.returnValue = ''; } };
        window.addEventListener('beforeunload', beforeUnload); editingChanged();
        return () => { unregister(); window.removeEventListener('beforeunload', beforeUnload); };
    }, [dirty, busy, rescheduling]);
    useEffect(() => { if (data && scope && !data.tasks.some(task => task.id === scope)) setScope(''); }, [data, scope]);
    const ownerName = (id: string | null) => id ? members.find(member => member.id === id)?.username || t('已离开的成员') : t('未分配');
    const path = (task: TaskFields) => ancestors(tasks, task.parentId).map(parent => parent.title).join(' / ');
    const childrenOf = (id: string) => tasks.filter(task => task.parentId === id);
    const open = (task: ScheduledTask) => { setSaveError(''); setEditor({ original: task, fields: fieldsOf(task) }); };
    const create = (parentId: string | null = null) => { setSaveError(''); setEditor({ original: null, fields: { ...emptyTask, parentId } }); };
    const close = () => { if (!busy && (!dirty || confirm(t('放弃未保存的任务修改？')))) { setEditor(null); setSaveError(''); } };
    const change = <Key extends keyof TaskFields>(key: Key, value: TaskFields[Key]) => setEditor(current => current && ({ ...current, fields: { ...current.fields, [key]: value } }));
    const requestIdFor = (payload: unknown) => {
        const signature = JSON.stringify(payload);
        if (lastRequest.current?.signature !== signature) lastRequest.current = { signature, requestId: randomUUID() };
        return lastRequest.current.requestId;
    };
    const save = async () => {
        if (!editor || sending.current) return;
        sending.current = true; setBusy(true); setSaveError('');
        const payload = { ...(editor.original ? { id: editor.original.id } : {}), version: editor.original?.version || 0, task: editor.fields };
        try {
            const saved: ScheduledTask = await api('/schedule/tasks', { ...payload, requestId: requestIdFor(payload) }, projectId);
            if (mounted.current) {
                setData(current => current && ({ ...current, tasks: [...current.tasks.filter(task => task.id !== saved.id), saved] }));
                setEditor(null); lastRequest.current = null; notify(t('任务已保存')); void load(true);
            }
        } catch (failure: any) { if (mounted.current) { setSaveError(failure.message); void load(true); } }
        finally { sending.current = false; if (mounted.current) setBusy(false); }
    };
    const reread = async () => {
        if (!editor?.original || sending.current || !confirm(t('放弃未保存的任务修改？'))) return;
        const id = editor.original.id;
        sending.current = true; setBusy(true);
        try {
            const next: ScheduleSnapshot = await api('/schedule', undefined, projectId);
            if (mounted.current) {
                setData(next);
                const current = next.tasks.find(task => task.id === id);
                if (current) { open(current); lastRequest.current = null; }
                else setSaveError(t('任务不存在'));
            }
        } catch (failure: any) { if (mounted.current) setSaveError(failure.message); }
        finally { sending.current = false; if (mounted.current) setBusy(false); }
    };
    const remove = async () => {
        if (!editor?.original || sending.current || !confirm(t('删除此任务？此操作不可撤销。'))) return;
        sending.current = true; setBusy(true); setSaveError('');
        const payload = { id: editor.original.id, version: editor.original.version };
        try {
            await api('/schedule/tasks/delete', { ...payload, requestId: requestIdFor(payload) }, projectId);
            if (mounted.current) { setEditor(null); lastRequest.current = null; void load(); }
        } catch (failure: any) { if (mounted.current) { setSaveError(failure.message); void load(true); } }
        finally { sending.current = false; if (mounted.current) setBusy(false); }
    };
    const scopeIds = scope ? new Set([scope, ...descendants(tasks, scope)]) : null;
    const filtered = tasks.filter(task => (!scopeIds || scopeIds.has(task.id)) && (!mine || task.ownerIds.includes(identity.id)));
    const backlog = filtered.filter(task => !task.startDate);
    const summary = (task: ScheduledTask) => {
        const children = childrenOf(task.id);
        if (!children.length) return '';
        const done = children.filter(child => child.status === 'done').length, blocked = children.filter(child => child.status === 'blocked').length;
        return t('子任务') + ' ' + done + '/' + children.length + (blocked ? ' · ' + blocked + ' ' + t('阻塞') : '') + (done === children.length && task.status !== 'done' ? ' · ' + t('待验收') : '');
    };
    const editedDescendants = editor?.original ? descendants(tasks, editor.original.id) : new Set<string>();
    const parentOptions = tasks.filter(task => task.id !== editor?.original?.id && !editedDescendants.has(task.id));
    const warnings = editor ? dateWarnings(tasks, editor.fields) : [];
    const childrenOutside = editor?.fields.startDate && editor.fields.endDate ? tasks.filter(task => editedDescendants.has(task.id) && task.startDate && task.endDate && (task.startDate < editor.fields.startDate! || task.endDate > editor.fields.endDate!)) : [];
    return <div className="schedule-page">
        <header className="schedule-heading"><div><span className="eyebrow">{t('项目共享')} / {t('跨版本协作')}</span><h1>{t('任务排期')}</h1><p>{t('先看每个人最近在忙什么，再展开任务背后的大目标。')}</p></div>{manage && <button className="primary" disabled={rescheduling} onClick={() => create(scope || null)}><Plus size={16}/>{t('新建任务')}</button>}</header>
        {error && <div className="schedule-error" role="alert">{error} <button onClick={() => void load()} disabled={refreshing}>{t('重试')}</button></div>}
        {!data ? !error && <div className="empty">{t('正在加载排期…')}</div> : <>
            <div className="schedule-toolbar"><div className="schedule-view" role="group" aria-label={t('排期视图')}><button disabled={rescheduling} className={view === 'people' ? 'active' : ''} aria-pressed={view === 'people'} onClick={() => setView('people')}><UserRound size={15}/>{t('成员排期')}</button><button disabled={rescheduling} className={view === 'tree' ? 'active' : ''} aria-pressed={view === 'tree'} onClick={() => setView('tree')}><GitBranch size={15}/>{t('任务树')}</button></div>
                <label className="schedule-filter">{t('任务范围')}<select disabled={rescheduling} value={scope} onChange={event => { setScope(event.target.value); }}><option value="">{t('全部任务')}</option>{tasks.map(task => <option key={task.id} value={task.id}>{[path(task), task.title].filter(Boolean).join(' / ')}</option>)}</select></label>
                <button disabled={rescheduling} aria-pressed={mine} className={mine ? 'active' : ''} onClick={() => setMine(!mine)}>{t('只看我的')}</button>
                <button disabled={rescheduling} className="icon" aria-label={t('刷新排期')}  onClick={() => void load()}><RefreshCw size={16}/></button>
            </div>
            <div className="schedule-calendar-controls"><div className="actions"><button disabled={rescheduling} className="icon" aria-label={t('上一段日期')} onClick={() => setStart(start - days)}><ChevronLeft size={17}/></button><button disabled={rescheduling} onClick={() => setStart(dateNumber(localToday()))}>{t('今天')}</button><button disabled={rescheduling} className="icon" aria-label={t('下一段日期')} onClick={() => setStart(start + days)}><ChevronRight size={17}/></button><span>{dateString(start)} — {dateString(start + days - 1)}</span></div><label className="schedule-filter">{t('跨度')}<select disabled={rescheduling} value={days} onChange={event => setDays(Number(event.target.value))}><option value={14}>{t('两周')}</option><option value={28}>{t('四周')}</option></select></label></div>
            {!tasks.length ? <div className="schedule-empty"><ChartNoAxesGantt size={36}/><h2>{t('从一个大目标，或一件小事开始')}</h2><p>{t('所有任务都可以继续拆分。先创建任务，再分配成员和日期。')}</p>{manage ? <button onClick={() => create()}><Plus size={16}/>{t('创建第一个任务')}</button> : <p>{t('请联系拥有排期管理权限的成员创建任务。')}</p>}</div> : <>
                <ScheduleTimeline tasks={tasks} filtered={filtered} members={members} view={view} mine={mine} userId={identity.id} projectId={projectId} scope={scope} start={start} days={days} manage={manage} onOpen={open} onCreate={create} onSaved={saved => { setData(current => current && ({ ...current, tasks: current.tasks.map(task => task.id === saved.id && task.version <= saved.version ? saved : task) })); }} onRefresh={() => void load(true)} onInteraction={setRescheduling}/>
                {view === 'people' && <section className="schedule-backlog"><header><h2><CalendarDays size={17}/>{t('待排期')} <span>{backlog.length}</span></h2><small>{t('尚未承诺交付日期')}</small></header>{backlog.length ? <div className="schedule-backlog-list">{backlog.map(task => <button key={task.id} onClick={() => open(task)}><strong>{task.title}</strong><span>{(task.ownerIds.length ? task.ownerIds.map(ownerName).join('、') : t('未分配'))} · {t(taskStatuses[task.status])}</span><small>{path(task) || t('顶层任务')}</small></button>)}</div> : <div className="muted">{t('没有待排期任务')}</div>}</section>}
            </>}
            <p className="schedule-footnote">{t('共享排期独立于设计草稿与发布版本，每 15 秒刷新。')}</p>
        </>}
        {editor && <Modal title={editor.original ? t('任务详情') : t('新建任务')} className="schedule-drawer" busy={busy} onClose={close}>
            <form onSubmit={event => { event.preventDefault(); void save(); }}>
                <div className="schedule-editor-body">
                    {editor.original && <div className="schedule-detail-meta"><span>{t('版本')} {editor.original.version}</span><span>{summary(editor.original)}</span></div>}
                    {saveError && <div className="schedule-error" role="alert">{saveError}<p>{t('输入已保留；重新读取会放弃当前修改。')}</p>{editor.original && <button type="button" disabled={busy} onClick={() => void reread()}>{t('重新读取')}</button>}</div>}
                    <fieldset disabled={busy}><label>{t('任务标题')}<input required maxLength={200} value={editor.fields.title} disabled={!manage} onChange={event => change('title', event.target.value)} placeholder={t('描述一个明确的交付结果')}/></label>
                    <label>{t('父任务')}<select value={editor.fields.parentId || ''} disabled={!manage} onChange={event => change('parentId', event.target.value || null)}><option value="">{t('无父任务（顶层）')}</option>{parentOptions.map(task => <option key={task.id} value={task.id}>{[path(task), task.title].filter(Boolean).join(' / ')}</option>)}</select></label>
                    <div className="schedule-form-pair"><fieldset className="schedule-assignees" disabled={!manage}><legend>{t('负责人')}</legend><small>{t('可多选；不选择则为未分配')}</small><div>{members.filter(member => member.active || editor.fields.ownerIds.includes(member.id)).map(member => <label key={member.id}><input type="checkbox" checked={editor.fields.ownerIds.includes(member.id)} disabled={!member.active && !editor.fields.ownerIds.includes(member.id)} onChange={event => change('ownerIds', event.target.checked ? [...editor.fields.ownerIds, member.id].sort() : editor.fields.ownerIds.filter(id => id !== member.id))}/>{member.username}{member.active ? '' : ' · ' + t('不可分配')}</label>)}</div></fieldset><label>{t('状态')}<select value={editor.fields.status} disabled={!canUpdate} onChange={event => change('status', event.target.value as TaskFields['status'])}>{Object.entries(taskStatuses).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label></div>
                    <div className="schedule-form-pair"><label>{t('开始日期')}<input type="date" min="1900-01-01" max="9998-12-31" required={!!editor.fields.endDate} disabled={!manage} value={editor.fields.startDate || ''} onChange={event => change('startDate', event.target.value || null)}/></label><label>{t('结束日期')}<input type="date" min={editor.fields.startDate || '1900-01-01'} max="9998-12-31" required={!!editor.fields.startDate} disabled={!manage} value={editor.fields.endDate || ''} onChange={event => change('endDate', event.target.value || null)}/></label></div>
                    {manage && (editor.fields.startDate || editor.fields.endDate) && <button className="subtle small" type="button" onClick={() => setEditor(current => current && ({ ...current, fields: { ...current.fields, startDate: null, endDate: null } }))}>{t('移回待排期')}</button>}
                    {(warnings.length > 0 || childrenOutside.length > 0) && <div className="schedule-warning" role="status">{warnings.length > 0 && <div>{t('超出上级排期')}：{warnings.map(task => task.title).join('、')}</div>}{childrenOutside.length > 0 && <div>{t('子任务超出当前排期')}：{childrenOutside.map(task => task.title).join('、')}</div>}{t('保存不会自动调整其他任务的日期。')}</div>}
                    {editor.fields.status === 'blocked' && <label>{t('阻塞原因')}<textarea required maxLength={2000} rows={2} value={editor.fields.blockedReason} disabled={!canUpdate} onChange={event => change('blockedReason', event.target.value)}/></label>}
                    <label>{t('任务说明')}<textarea maxLength={8000} rows={4} value={editor.fields.description} disabled={!canUpdate} onChange={event => change('description', event.target.value)}/></label>
                    <label>{t('完成标准')}<textarea maxLength={4000} rows={3} value={editor.fields.acceptance} disabled={!manage} onChange={event => change('acceptance', event.target.value)} placeholder={t('做到什么才算完成？')}/></label></fieldset>
                    {editor.original && <section className="schedule-children"><header><h3>{t('子任务')} · {childrenOf(editor.original.id).length}</h3>{manage && <button type="button" className="small" disabled={busy} onClick={() => { if (!dirty || confirm(t('放弃未保存的任务修改？'))) create(editor.original!.id); }}><Plus size={14}/>{t('添加子任务')}</button>}</header>{childrenOf(editor.original.id).map(child => <button type="button" key={child.id} disabled={busy} onClick={() => { if (!dirty || confirm(t('放弃未保存的任务修改？'))) open(child); }}><span>{child.title}</span><small>{(child.ownerIds.length ? child.ownerIds.map(ownerName).join('、') : t('未分配'))} · {t(taskStatuses[child.status])}</small></button>)}</section>}
                </div><footer className="schedule-editor-footer">{manage && editor.original && <button type="button" className="danger" disabled={busy || childrenOf(editor.original.id).length > 0} title={t('有子任务时不能删除')} onClick={() => void remove()}>{t('删除')}</button>}<span className="spacer"/><button type="button" disabled={busy} onClick={close}>{t('关闭')}</button>{canUpdate && <button className="primary" type="submit" disabled={busy || !editor.fields.title.trim()}>{busy ? t('正在保存…') : t('保存任务')}</button>}</footer>
            </form>
        </Modal>}
    </div>;
}
