import { ancestors, dateNumber, dateString, type ScheduledTask } from '../shared/schedule';

export type ScheduleRow = { task: ScheduledTask; depth: number; context: boolean; hasChildren: boolean; parentRowId: string | null };
export type DateGesture = 'move' | 'start' | 'end';
export function scheduleRows(tasks: ScheduledTask[], included: Set<string>, collapsed: Set<string>, scope = ''): ScheduleRow[] {
    const visible = new Set(included);
    for (const task of tasks) if (included.has(task.id)) {
        const parents = ancestors(tasks, task.parentId);
        const start = scope ? parents.findIndex(parent => parent.id === scope) : -1;
        for (const parent of parents.slice(Math.max(0, start))) if (!scope || start >= 0) visible.add(parent.id);
    }
    const children = new Map<string | null, ScheduledTask[]>();
    for (const task of tasks) if (visible.has(task.id)) {
        const parentId = task.id !== scope && task.parentId && visible.has(task.parentId) ? task.parentId : null;
        const siblings = children.get(parentId) || []; siblings.push(task); children.set(parentId, siblings);
    }
    const pending = [...(children.get(null) || [])].reverse().map(task => ({ task, depth: 0, parentRowId: null as string | null }));
    const rows: ScheduleRow[] = [], visited = new Set<string>();
    while (pending.length) {
        const row = pending.pop()!;
        if (visited.has(row.task.id)) continue;
        visited.add(row.task.id);
        const nested = children.get(row.task.id) || [];
        rows.push({ ...row, context: !included.has(row.task.id), hasChildren: nested.length > 0 });
        if (!collapsed.has(row.task.id)) pending.push(...[...nested].reverse().map(task => ({ task, depth: row.depth + 1, parentRowId: row.task.id })));
    }
    return rows;
}
export function rescheduledDates(task: ScheduledTask, mode: DateGesture, offset: number) {
    if (!task.startDate || !task.endDate) throw Error('未排期任务不能拖动');
    const start = dateNumber(task.startDate), end = dateNumber(task.endDate);
    const minimum = dateNumber('1900-01-01'), maximum = dateNumber('9998-12-31');
    const shift = Math.round(offset);
    if (mode === 'move') {
        const delta = Math.max(minimum - start, Math.min(maximum - end, shift));
        return { startDate: dateString(start + delta), endDate: dateString(end + delta) };
    }
    return mode === 'start'
        ? { startDate: dateString(Math.max(minimum, Math.min(end, start + shift))), endDate: task.endDate }
        : { startDate: task.startDate, endDate: dateString(Math.min(maximum, Math.max(start, end + shift))) };
}
