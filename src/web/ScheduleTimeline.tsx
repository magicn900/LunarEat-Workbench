import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { ChevronDown, ChevronRight, Plus, Undo2 } from 'lucide-react';
import { ancestors, dateNumber, dateString, dateWarnings, localToday, taskStatuses, type ScheduledTask, type ScheduleMember } from '../shared/schedule';
import { rescheduledDates, scheduleRows, type DateGesture, type ScheduleRow } from './scheduleLayout';
import { api } from './state';
import { randomUUID } from './uuid';
import { t } from './i18n';

type Dates = { startDate: string; endDate: string };
type Gesture = { task: ScheduledTask; mode: DateGesture; pointerId: number; origin: number; trackLeft: number; cellWidth: number; target: HTMLElement; dates: Dates; moved: boolean };
type Props = {
    tasks: ScheduledTask[]; filtered: ScheduledTask[]; members: ScheduleMember[]; view: 'people' | 'tree'; mine: boolean; userId: string; projectId: string; scope: string; start: number; days: number; manage: boolean;
    onOpen: (task: ScheduledTask) => void; onCreate: (parentId: string) => void; onSaved: (task: ScheduledTask) => void; onRefresh: () => void; onInteraction: (busy: boolean) => void;
};
function fields(task: ScheduledTask, dates: { startDate: string | null; endDate: string | null }) {
    const { title, description, acceptance, parentId, ownerIds, status, blockedReason } = task;
    return { title, description, acceptance, parentId, ownerIds, status, blockedReason, ...dates };
}
export function ScheduleTimeline({ tasks, filtered, members, view, mine, userId, projectId, scope, start, days, manage, onOpen, onCreate, onSaved, onRefresh, onInteraction }: Props) {
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    const [gesture, setGesture] = useState<Gesture | null>(null), [saving, setSaving] = useState(false);
    const [pending, setPending] = useState<{ task: ScheduledTask; dates: Dates } | null>(null);
    const [feedback, setFeedback] = useState(''), [failure, setFailure] = useState('');
    const [undo, setUndo] = useState<{ saved: ScheduledTask; before: ScheduledTask } | null>(null);
    const active = useRef<Gesture | null>(null), sending = useRef(false), mounted = useRef(true);
    const suppressedClick = useRef({ id: '', until: 0 });
    const today = dateNumber(localToday());
    const ownerName = (id: string | null) => id ? members.find(member => member.id === id)?.username || t('已离开的成员') : t('未分配');
    useEffect(() => { setCollapsed(new Set()); }, [view, mine, scope]);
    useEffect(() => { onInteraction(!!gesture || saving); return () => onInteraction(false); }, [!!gesture, saving, onInteraction]);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; active.current = null; }; }, []);
    const cancel = () => {
        const current = active.current;
        active.current = null; setGesture(null);
        if (current) {
            suppressedClick.current = { id: current.task.id, until: Date.now() + 500 };
            if (current.target.hasPointerCapture(current.pointerId)) current.target.releasePointerCapture(current.pointerId);
        }
        setFeedback(t('已取消改期'));
    };
    useEffect(() => {
        const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape' && active.current) { event.preventDefault(); cancel(); } };
        const blur = () => { if (active.current) cancel(); };
        window.addEventListener('keydown', escape); window.addEventListener('blur', blur);
        return () => { window.removeEventListener('keydown', escape); window.removeEventListener('blur', blur); };
    }, []);
    useEffect(() => { if (!manage && active.current) cancel(); }, [manage]);
    const commit = async (task: ScheduledTask, dates: Dates, undoing = false) => {
        if (!manage || sending.current || dates.startDate === task.startDate && dates.endDate === task.endDate) return;
        sending.current = true; setSaving(true); setFailure(''); setPending({ task, dates });
        try {
            const saved: ScheduledTask = await api('/schedule/tasks', { requestId: randomUUID(), id: task.id, version: task.version, task: fields(task, dates) }, projectId);
            if (mounted.current) {
                onSaved(saved); setUndo(undoing ? null : { saved, before: task });
                setFeedback((undoing ? t('已撤销改期') : t('排期已保存')) + ' · ' + task.title + ' · ' + saved.startDate + ' — ' + saved.endDate);
            }
        } catch (error: any) {
            if (mounted.current) { setFailure(error.message + ' · ' + t('改期未确认，请刷新核对后重试。')); onRefresh(); }
        } finally {
            sending.current = false;
            if (mounted.current) { setSaving(false); setPending(null); }
        }
    };
    const begin = (event: PointerEvent<HTMLElement>, task: ScheduledTask, mode: DateGesture) => {
        if (!manage || sending.current || active.current || event.button !== 0 || !task.startDate || !task.endDate) return;
        const track = event.currentTarget.closest<HTMLElement>('.schedule-track')!;
        const rectangle = track.getBoundingClientRect();
        suppressedClick.current = { id: '', until: 0 };
        const next: Gesture = { task, mode, pointerId: event.pointerId, origin: event.clientX, trackLeft: rectangle.left, cellWidth: rectangle.width / days, target: track, dates: { startDate: task.startDate, endDate: task.endDate }, moved: false };
        active.current = next; setGesture(next); setFailure('');
        event.currentTarget.focus();
        track.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent<HTMLElement>) => {
        const current = active.current;
        if (!current || current.pointerId !== event.pointerId) return;
        const distance = event.clientX - current.origin + current.trackLeft - current.target.getBoundingClientRect().left;
        const next = { ...current, moved: current.moved || Math.abs(distance) >= 4, dates: rescheduledDates(current.task, current.mode, distance / current.cellWidth) };
        active.current = next; setGesture(next);
    };
    const finish = (event: PointerEvent<HTMLElement>) => {
        if (!active.current || active.current.pointerId !== event.pointerId) return;
        move(event);
        const current = active.current!;
        active.current = null; setGesture(null);
        if (current.target.hasPointerCapture(current.pointerId)) current.target.releasePointerCapture(current.pointerId);
        if (current.moved) {
            suppressedClick.current = { id: current.task.id, until: Date.now() + 500 };
            void commit(current.task, current.dates);
        } else if (current.mode === 'move') onOpen(current.task);
    };
    const keyboard = (event: KeyboardEvent<HTMLElement>, task: ScheduledTask, mode: DateGesture) => {
        if (!manage || sending.current || active.current || !['ArrowLeft', 'ArrowRight'].includes(event.key) || event.metaKey || event.ctrlKey || event.altKey) return;
        event.preventDefault();
        void commit(task, rescheduledDates(task, mode, event.key === 'ArrowLeft' ? -1 : 1));
    };
    const openBar = (task: ScheduledTask, detail: number) => {
        if (sending.current || detail > 0 && suppressedClick.current.id === task.id && Date.now() < suppressedClick.current.until) return;
        if (detail === 0 || !manage) onOpen(task);
    };
    const toggle = (key: string) => setCollapsed(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; });
    const children = (id: string) => tasks.filter(task => task.parentId === id);
    const preview = (task: ScheduledTask) => {
        if (gesture?.task.id === task.id) return { ...gesture.task, ...gesture.dates };
        if (pending?.task.id === task.id) return { ...pending.task, ...pending.dates };
        return task;
    };
    const renderRow = (row: ScheduleRow, group: string) => {
        const original = row.task, task = preview(original), nested = children(task.id), parent = nested.length > 0;
        const collapseKey = group + ':' + task.id;
        const left = task.startDate ? dateNumber(task.startDate) - start : 0, right = task.endDate ? dateNumber(task.endDate) - start + 1 : 0;
        const visible = task.startDate && task.endDate && right > 0 && left < days;
        const editable = manage && !row.context;
        const changing = gesture?.task.id === task.id && gesture.moved || pending?.task.id === task.id;
        const complete = nested.filter(child => child.status === 'done').length;
        const label = task.title + ' · ' + t(taskStatuses[task.status]) + ' · ' + task.startDate + ' — ' + task.endDate;
        const breadcrumb = ancestors(tasks, task.parentId).map(ancestor => ancestor.title).join(' / ');
        return <div className={'schedule-row' + (row.context ? ' is-context' : '') + (parent ? ' has-subtasks' : '') + (changing ? ' is-changing' : '')} key={task.id} data-task-id={task.id} data-context={row.context} data-depth={row.depth}>
            <div className="schedule-task-label" style={{ '--task-depth': Math.min(row.depth, 8) } as CSSProperties}>
                {row.depth > 0 && <span className="schedule-branch" aria-hidden="true"/>}
                {row.hasChildren ? <button className="icon schedule-fold" aria-label={t(collapsed.has(collapseKey) ? '展开子任务' : '收起子任务')} aria-expanded={!collapsed.has(collapseKey)} disabled={saving || !!gesture} onClick={() => toggle(collapseKey)}>{collapsed.has(collapseKey) ? <ChevronRight size={15}/> : <ChevronDown size={15}/>}</button> : <span className="schedule-fold-space"/>}
                <button className="schedule-task-open" disabled={saving || !!gesture} onClick={() => onOpen(original)} title={breadcrumb ? breadcrumb + ' / ' + task.title : task.title}>
                    <span>{task.title}</span><small>{row.context ? t('上级任务') + ' · ' : ''}{(task.ownerIds.length ? task.ownerIds.map(ownerName).join('、') : t('未分配'))}{parent ? ' · ' + t('子任务') + ' ' + complete + '/' + nested.length : ''}{parent && complete === nested.length && task.status !== 'done' ? ' · ' + t('待验收') : ''}</small>
                    <small className={'schedule-status ' + task.status}><i aria-hidden="true"/>{t(taskStatuses[task.status])}{task.startDate ? ' · ' + task.startDate.slice(5) + ' — ' + task.endDate?.slice(5) : ' · ' + t('待排期')}{dateWarnings(tasks, task).length > 0 ? ' · ' + t('超出上级排期') : ''}</small>
                </button>
                {editable && <button className="icon schedule-add-child" disabled={saving || !!gesture} aria-label={t('添加子任务') + ' · ' + task.title} title={t('添加子任务')} onClick={() => onCreate(task.id)}><Plus size={14}/></button>}
            </div>
            <div className="schedule-track" onPointerMove={move} onPointerUp={finish} onPointerCancel={() => { if (active.current?.task.id === task.id) cancel(); }} onLostPointerCapture={() => { if (active.current?.task.id === task.id) cancel(); }}>
                {today >= start && today < start + days && <span className="schedule-today" style={{ left: (today - start) / days * 100 + '%' }} aria-hidden="true"/>}
                {visible ? <div className={'schedule-bar ' + task.status + (parent ? ' is-parent' : '') + (editable ? ' is-editable' : '') + (changing ? ' is-changing' : '')} data-task-id={task.id} style={{ left: Math.max(left, 0) / days * 100 + '%', width: (Math.min(right, days) - Math.max(left, 0)) / days * 100 + '%' }}>
                    <button className="schedule-bar-body" disabled={saving} onPointerDown={event => { if (editable) begin(event, original, 'move'); }} onClick={event => { if (row.context) onOpen(original); else openBar(original, event.detail); }} onKeyDown={event => { if (editable) keyboard(event, original, 'move'); }} aria-label={label} title={label + (editable ? ' · ' + t('拖动平移，左右方向键微调一天') : '')}><span>{task.title}</span><small>{parent ? complete + '/' + nested.length : t(taskStatuses[task.status])}</small></button>
                    {editable && left >= 0 && <button className="schedule-resize start" disabled={saving} aria-label={t('调整开始日期') + ' · ' + task.title} title={t('拖动调整开始日期')} onPointerDown={event => begin(event, original, 'start')} onKeyDown={event => keyboard(event, original, 'start')}><span/></button>}
                    {editable && right <= days && <button className="schedule-resize end" disabled={saving} aria-label={t('调整结束日期') + ' · ' + task.title} title={t('拖动调整结束日期')} onPointerDown={event => begin(event, original, 'end')} onKeyDown={event => keyboard(event, original, 'end')}><span/></button>}
                    {parent && <span className="schedule-parent-bracket" aria-hidden="true"/>}
                </div> : <span className="schedule-outside">{changing ? task.startDate + ' — ' + task.endDate : task.startDate ? t('不在当前日期范围') : t('待排期')}</span>}
            </div>
        </div>;
    };
    const rowsFor = (included: Set<string>, group: string) => scheduleRows(tasks, included, new Set([...collapsed].filter(key => key.startsWith(group + ':')).map(key => key.slice(group.length + 1))), scope);
    const scheduled = filtered.filter(task => task.startDate && task.endDate && dateNumber(task.startDate) < start + days && dateNumber(task.endDate) >= start);
    const ownerIds = [...new Set([...members.filter(member => member.active && (!mine || member.id === userId)).map(member => member.id), ...scheduled.flatMap(task => task.ownerIds.length ? task.ownerIds : [null])])];
    const treeRows = rowsFor(new Set(filtered.map(task => task.id)), 'tree');
    return <>
        <div className="schedule-interaction-status" role="status" aria-live="polite">
            <span>{gesture?.moved ? gesture.task.title + ' · ' + gesture.dates.startDate + ' → ' + gesture.dates.endDate + ' · ' + t('松开保存 · Esc 取消') : saving ? t('正在保存排期…') : feedback || (manage ? t('拖动任务条平移 · 拖两端改起止日期 · 单击查看详情') : t('单击任务查看详情'))}</span>
            {undo && manage && !gesture && <button className="small" disabled={saving} onClick={() => void commit(undo.saved, { startDate: undo.before.startDate!, endDate: undo.before.endDate! }, true)}><Undo2 size={14}/>{t('撤销改期')}</button>}
        </div>
        {failure && <div className="schedule-error" role="alert">{failure} <button onClick={onRefresh} disabled={saving}>{t('刷新排期')}</button></div>}
        <div className="schedule-timeline" tabIndex={0} role="region" aria-label={t('任务时间轴')}><div className="schedule-grid" style={{ '--schedule-days': days } as CSSProperties}>
            <div className="schedule-row schedule-date-header"><div className="schedule-task-label">{t(view === 'people' ? '负责人 / 任务' : '任务 / 负责人')}</div><div className="schedule-days">{Array.from({ length: days }, (_, index) => { const date = dateString(start + index), weekend = [0, 6].includes(new Date(date + 'T00:00:00Z').getUTCDay()); return <span key={date} className={(weekend ? 'weekend ' : '') + (date === localToday() ? 'today' : '')}>{index === 0 || date.endsWith('-01') ? date.slice(5, 7) + '/' : ''}{Number(date.slice(8))}</span>; })}</div></div>
            {view === 'people' ? ownerIds.filter(ownerId => !mine || ownerId === userId).map(ownerId => {
                const owned = scheduled.filter(task => ownerId ? task.ownerIds.includes(ownerId) : !task.ownerIds.length), group = 'owner:' + (ownerId || 'unassigned');
                const rows = rowsFor(new Set(owned.map(task => task.id)), group);
                return <section className="schedule-owner-group" key={group} data-owner-id={ownerId || ''} aria-label={ownerName(ownerId)}>
                    <div className="schedule-owner-row"><button className="subtle" disabled={saving || !!gesture} aria-expanded={!collapsed.has(group)} onClick={() => toggle(group)}>{collapsed.has(group) ? <ChevronRight size={15}/> : <ChevronDown size={15}/>}<span className="avatar">{ownerName(ownerId).slice(0, 1)}</span>{ownerName(ownerId)}{ownerId && !members.find(member => member.id === ownerId)?.active && <small>{t('不可分配')}</small>}</button><small>{owned.length} {t('项任务')} · {t('上级上下文不计入')}</small></div>
                    {!collapsed.has(group) && (rows.length ? rows.map(row => renderRow(row, group)) : <div className="schedule-idle">{t('当前日期范围没有已排期任务')}</div>)}
                </section>;
            }) : treeRows.length ? treeRows.map(row => renderRow(row, 'tree')) : <div className="empty">{t('没有匹配的任务')}</div>}
        </div></div>
        <div className="schedule-legend">{Object.entries(taskStatuses).map(([status, label]) => <span className={'schedule-status ' + status} key={status}><i aria-hidden="true"/>{t(label)}</span>)}<span>{t('底部括线表示含子任务，可折叠查看')}</span><span>{t('拖动父任务仅改变自身日期')}</span></div>
    </>;
}
