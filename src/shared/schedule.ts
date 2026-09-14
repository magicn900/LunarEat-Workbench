import { z } from 'zod';

export const taskStatuses = { todo: '待开始', doing: '进行中', blocked: '阻塞', done: '已完成' } as const;
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
    const date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && value >= '1900-01-01' && value <= '9998-12-31';
}, '日期不合法');
export const taskFieldsSchema = z.object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(8000),
    acceptance: z.string().max(4000),
    parentId: z.string().uuid().nullable(),
    ownerIds: z.array(z.string().min(1).max(150)).max(100).transform(ids => [...new Set(ids)].sort()),
    startDate: calendarDate.nullable(),
    endDate: calendarDate.nullable(),
    status: z.enum(['todo', 'doing', 'blocked', 'done']),
    blockedReason: z.string().max(2000)
}).strict();
export type TaskFields = z.infer<typeof taskFieldsSchema>;
export type ScheduledTask = TaskFields & { id: string; version: number; created: string; updated: string };
export type ScheduleMember = { id: string; username: string; active: boolean };
export type ScheduleSnapshot = { tasks: ScheduledTask[]; members: ScheduleMember[]; scopes: string[] };
export const emptyTask: TaskFields = { title: '', description: '', acceptance: '', parentId: null, ownerIds: [], startDate: null, endDate: null, status: 'todo', blockedReason: '' };
export function descendants(tasks: ScheduledTask[], id: string): Set<string> {
    const children = new Map<string, string[]>();
    for (const task of tasks) if (task.parentId) children.set(task.parentId, [...(children.get(task.parentId) || []), task.id]);
    const result = new Set<string>(), pending = [...(children.get(id) || [])];
    while (pending.length) {
        const current = pending.pop()!;
        if (result.has(current)) continue;
        result.add(current); pending.push(...(children.get(current) || []));
    }
    return result;
}
export function ancestors(tasks: ScheduledTask[], parentId: string | null): ScheduledTask[] {
    const byId = new Map(tasks.map(task => [task.id, task]));
    const result: ScheduledTask[] = [], visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
        visited.add(parentId);
        const parent = byId.get(parentId);
        if (!parent) break;
        result.unshift(parent); parentId = parent.parentId;
    }
    return result;
}
export function dateWarnings(tasks: ScheduledTask[], task: TaskFields): ScheduledTask[] {
    if (!task.startDate || !task.endDate) return [];
    return ancestors(tasks, task.parentId).filter(parent => parent.startDate && parent.endDate && (task.startDate! < parent.startDate || task.endDate! > parent.endDate));
}
export function dateNumber(value: string): number { return Math.floor(Date.parse(value + 'T00:00:00Z') / 86400000); }
export function dateString(day: number): string { return new Date(day * 86400000).toISOString().slice(0, 10); }
export function localToday(): string {
    const date = new Date();
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
