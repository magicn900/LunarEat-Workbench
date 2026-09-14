import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from './store.js';
import type { Actor } from '../shared/model.js';
import { Fault, requireScope } from './auth.js';
import { writableProject } from './projectState.js';
import { audit } from './administration.js';
import { ancestors, descendants, taskFieldsSchema, type ScheduledTask, type ScheduleMember, type TaskFields } from '../shared/schedule.js';

function normalizeOwners(raw: unknown): unknown {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const { ownerId, ...fields } = raw as Record<string, unknown>;
    return { ...fields, ownerIds: Object.hasOwn(fields, 'ownerIds') ? fields.ownerIds : (ownerId == null ? [] : [ownerId]) };
}
const saveSchema = z.object({ requestId: z.string().uuid(), id: z.string().uuid().optional(), version: z.number().int().min(0), task: z.preprocess(normalizeOwners, taskFieldsSchema) }).strict();
const deleteSchema = z.object({ requestId: z.string().uuid(), id: z.string().uuid(), version: z.number().int().positive() }).strict();
export class Schedule {
    constructor(private store: Store) {}
    tasks(projectId: string): ScheduledTask[] {
        return (this.store.db.prepare('SELECT id,version,created,updated,data FROM schedule_tasks WHERE project_id=? ORDER BY created,id').all(projectId) as { id: string; version: number; created: string; updated: string; data: string }[]).map(({ data, ...task }) => ({ ...normalizeOwners(JSON.parse(data)) as TaskFields, ...task }));
    }
    members(projectId: string): ScheduleMember[] {
        return (this.store.db.prepare(
            "SELECT u.id,u.username,CASE WHEN m.user_id IS NOT NULL AND COALESCE(a.disabled,0)=0 AND d.user_id IS NULL THEN 1 ELSE 0 END AS active FROM users u LEFT JOIN members m ON m.user_id=u.id AND m.project_id=? LEFT JOIN account_access a ON a.user_id=u.id LEFT JOIN deleted_accounts d ON d.user_id=u.id WHERE m.user_id IS NOT NULL OR u.id IN (SELECT owners.value FROM schedule_tasks, json_each(COALESCE(json_extract(data,'$.ownerIds'),json_array(json_extract(data,'$.ownerId')))) owners WHERE project_id=?) ORDER BY u.username,u.id"
        ).all(projectId, projectId) as { id: string; username: string; active: number }[]).map(member => ({ ...member, active: !!member.active }));
    }
    private write<Result>(actor: Actor, input: { requestId: string }, kind: string, action: () => Result): Result {
        writableProject(this.store, actor.projectId);
        return this.store.db.transaction(() => {
            const key = 'schedule:' + actor.projectId + ':' + actor.userId + ':' + input.requestId;
            const fingerprint = this.store.hash(JSON.stringify({ kind, input }));
            const saved = this.store.db.prepare('SELECT result FROM requests WHERE key=?').get(key) as { result: string } | undefined;
            if (saved) {
                const previous = JSON.parse(saved.result);
                if (previous.fingerprint !== fingerprint) throw new Fault(409, '请求标识已用于其他任务修改');
                return previous.result as Result;
            }
            const result = action();
            this.store.db.prepare('INSERT INTO requests VALUES (?,?)').run(key, JSON.stringify({ fingerprint, result }));
            return result;
        })();
    }
    save(actor: Actor, raw: unknown): ScheduledTask {
        requireScope(actor, 'schedule.read');
        const manage = actor.scopes.includes('schedule.manage');
        if (!manage) requireScope(actor, 'schedule.update');
        const input = saveSchema.parse(raw);
        return this.write(actor, input, 'save', () => {
            const tasks = this.tasks(actor.projectId), current = input.id ? tasks.find(task => task.id === input.id) : undefined;
            if (input.id && !current) throw new Fault(404, '任务不存在');
            if ((current?.version || 0) !== input.version) throw new Fault(409, '任务已被他人修改，请重新读取后再保存');
            const fields: TaskFields = input.task;
            if (!manage && (!current || !current.ownerIds.includes(actor.userId) || (['title', 'acceptance', 'parentId', 'ownerIds', 'startDate', 'endDate'] as const).some(key => JSON.stringify(current[key]) !== JSON.stringify(fields[key])))) throw new Fault(403, '只能更新自己负责的任务状态、说明和阻塞原因');
            if (!!fields.startDate !== !!fields.endDate || fields.startDate && fields.endDate && fields.endDate < fields.startDate) throw new Fault(400, '请同时设置有效的起止日期，结束日期不能早于开始日期');
            if (fields.status === 'blocked' && !fields.blockedReason.trim()) throw new Fault(400, '请填写阻塞原因');
            if (fields.ownerIds.some(id => !current?.ownerIds.includes(id) && !this.members(actor.projectId).some(member => member.id === id && member.active))) throw new Fault(400, '负责人必须是当前项目的可用成员');
            const id = input.id || randomUUID();
            const nested = descendants(tasks, id);
            if (fields.parentId === id || fields.parentId && nested.has(fields.parentId)) throw new Fault(400, '不能将任务移动到自身或后代任务下');
            if (fields.parentId && !tasks.some(task => task.id === fields.parentId)) throw new Fault(404, '父任务不存在');
            if (fields.status === 'done' && tasks.some(task => nested.has(task.id) && task.status !== 'done')) throw new Fault(409, '请先完成或移出所有未完成的子任务');
            if (fields.status !== 'done' && ancestors(tasks, fields.parentId).some(parent => parent.status === 'done')) throw new Fault(409, '请先重新开启已完成的上级任务');
            const now = new Date().toISOString();
            const task: ScheduledTask = { ...fields, id, version: input.version + 1, created: current?.created || now, updated: now };
            this.store.db.prepare('INSERT INTO schedule_tasks(id,project_id,version,created,updated,data) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,updated=excluded.updated,data=excluded.data').run(id, actor.projectId, task.version, task.created, now, JSON.stringify(fields));
            audit(this.store, actor.username, current ? '修改排期任务' : '创建排期任务', id, { projectId: actor.projectId, before: current || null, after: task });
            this.store.emit(actor.projectId, null, 'schedule.changed', { id, version: task.version });
            return task;
        });
    }
    remove(actor: Actor, raw: unknown) {
        requireScope(actor, 'schedule.manage');
        const input = deleteSchema.parse(raw);
        return this.write(actor, input, 'delete', () => {
            const tasks = this.tasks(actor.projectId), current = tasks.find(task => task.id === input.id);
            if (!current) throw new Fault(404, '任务不存在');
            if (current.version !== input.version) throw new Fault(409, '任务已被他人修改，请重新读取后再删除');
            if (tasks.some(task => task.parentId === current.id)) throw new Fault(409, '请先移出或删除子任务，不支持级联删除');
            this.store.db.prepare('DELETE FROM schedule_tasks WHERE project_id=? AND id=?').run(actor.projectId, current.id);
            audit(this.store, actor.username, '删除排期任务', current.id, { projectId: actor.projectId, before: current });
            this.store.emit(actor.projectId, null, 'schedule.changed', { id: current.id, removed: true });
            return { ok: true };
        });
    }
}
export function registerSchedule(app: FastifyInstance, store: Store, actor: (request: any) => Actor) {
    const schedule = new Schedule(store);
    app.get('/api/schedule', async request => {
        const current = actor(request); requireScope(current, 'schedule.read');
        return { tasks: schedule.tasks(current.projectId), members: schedule.members(current.projectId), scopes: current.scopes };
    });
    app.post('/api/schedule/tasks', async request => schedule.save(actor(request), request.body));
    app.post('/api/schedule/tasks/delete', async request => schedule.remove(actor(request), request.body));
}
