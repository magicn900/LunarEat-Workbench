import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from './store.js';
import { Fault, passwordHash } from './auth.js';
import { administrator, audit } from './administration.js';
import { initializeProject, projectState } from './projectState.js';

const targetSchema = z.object({ kind: z.enum(['account', 'project', 'member']), id: z.string().min(1).max(150), projectId: z.string().min(1).max(150).optional() });
type Target = z.infer<typeof targetSchema>;
export class Lifecycle {
    constructor(private store: Store) {}
    private account(id: string) {
        const row = this.store.db.prepare('SELECT u.id,u.username,COALESCE(a.administrator,0) AS administrator,COALESCE(a.disabled,0) AS disabled FROM users u LEFT JOIN account_access a ON a.user_id=u.id WHERE u.id=? AND NOT EXISTS (SELECT 1 FROM deleted_accounts d WHERE d.user_id=u.id)').get(id) as { id: string; username: string; administrator: number; disabled: number } | undefined;
        if (!row) throw new Fault(404, '账号不存在或已删除');
        return row;
    }
    private activity(workspaces: { id: string }[]) {
        const ids = new Set(workspaces.map(workspace => workspace.id));
        const sessions = (this.store.db.prepare("SELECT id,workspace_id,status FROM write_sessions WHERE status IN ('active','pending') AND expires>? ORDER BY id").all(Date.now()) as any[]).filter(session => ids.has(session.workspace_id));
        const clients = (this.store.db.prepare('SELECT id,workspace_id FROM web_clients WHERE dirty=1 ORDER BY workspace_id,id').all() as any[]).filter(client => ids.has(client.workspace_id));
        return { sessions, clients };
    }
    private workspaces(target: Target) {
        return this.store.db.prepare('SELECT w.id,w.project_id,w.head,w.base,w.version,p.name,CASE WHEN r.tree=w.head THEN 0 ELSE 1 END AS unpublished FROM workspaces w JOIN projects p ON p.id=w.project_id LEFT JOIN revisions r ON r.id=w.base AND r.project_id=w.project_id WHERE ' + (target.kind === 'project' ? 'w.project_id=?' : target.kind === 'member' ? 'w.user_id=? AND w.project_id=?' : 'w.user_id=? AND NOT EXISTS (SELECT 1 FROM project_lifecycle s WHERE s.project_id=w.project_id AND s.deleted=1)') + ' ORDER BY w.id').all(...(target.kind === 'member' ? [target.id, target.projectId] : [target.id])) as { id: string; project_id: string; name: string; head: string; base: string; version: number; unpublished: number }[];
    }
    preview(target: Target, currentUserId: string) {
        const entity = target.kind === 'project' ? projectState(this.store, target.id) : this.account(target.id);
        if (target.kind === 'member') {
            if (!target.projectId) throw new Fault(400, '缺少项目标识');
            projectState(this.store, target.projectId);
            if (!this.store.db.prepare('SELECT 1 FROM members WHERE user_id=? AND project_id=?').get(target.id, target.projectId)) throw new Fault(404, '项目成员已不存在');
        }
        const workspaces = this.workspaces(target), activity = this.activity(workspaces);
        const projectId = target.kind === 'project' ? target.id : target.projectId;
        const members = this.store.db.prepare('SELECT m.*,p.scopes FROM members m LEFT JOIN member_permissions p ON p.user_id=m.user_id AND p.project_id=m.project_id WHERE ' + (target.kind === 'project' ? 'm.project_id=?' : target.kind === 'member' ? 'm.user_id=? AND m.project_id=?' : 'm.user_id=?') + ' ORDER BY m.user_id,m.project_id').all(...(target.kind === 'member' ? [target.id, projectId] : [target.id]));
        const tokens = this.store.db.prepare('SELECT id,scopes FROM tokens WHERE ' + (target.kind === 'project' ? 'project_id=?' : target.kind === 'member' ? 'user_id=? AND project_id=?' : 'user_id=?') + ' ORDER BY id').all(...(target.kind === 'member' ? [target.id, projectId] : [target.id]));
        const revisions = target.kind === 'project' ? this.store.db.prepare('SELECT id FROM revisions WHERE project_id=? ORDER BY id').all(target.id) : [];
        const notes = target.kind === 'project' ? this.store.db.prepare('SELECT id,version FROM notes WHERE project_id=? ORDER BY id').all(target.id) : [];

        const scheduledTasks = this.store.db.prepare("SELECT id,version FROM schedule_tasks WHERE " + (target.kind === 'project' ? 'project_id=?' : target.kind === 'member' ? "EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(data,'$.ownerIds'),json_array(json_extract(data,'$.ownerId')))) WHERE value=?) AND project_id=?" : "EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(data,'$.ownerIds'),json_array(json_extract(data,'$.ownerId')))) WHERE value=?)") + ' ORDER BY id').all(...(target.kind === 'member' ? [target.id, projectId] : [target.id]));
        const blockers: string[] = [];
        if (activity.sessions.length) blockers.push('存在活动 Agent 写入，请先结束写入或收回控制权');
        if (activity.clients.length) blockers.push('存在未保存的网页输入，请先回到对应页面保存');
        if (target.kind === 'account') {
            if (target.id === currentUserId) blockers.push('不能删除当前登录账号');
            if ((entity as any).administrator && !(entity as any).disabled && (this.store.db.prepare('SELECT COUNT(*) AS count FROM account_access WHERE administrator=1 AND disabled=0').get() as any).count <= 1) blockers.push('必须保留至少一个可用的平台管理员');
            if (workspaces.some(workspace => workspace.unpublished)) blockers.push('存在未发布草稿，请由账号本人发布或丢弃后再删除账号');
        }
        if (target.kind === 'project' && !(entity as any).archived) blockers.push('请先归档项目，再删除项目');
        const projects = (members as { project_id: string }[]).map(member => this.store.db.prepare('SELECT id,name FROM projects WHERE id=?').get(member.project_id) as { id: string; name: string });
        const relatedProjects = [...new Map(projects.map(project => [project.id, project])).values()];
        const detail = { entity, members, tokens, workspaces, activity, revisions, notes, scheduledTasks, relatedProjects };
        return { ...target, projects: relatedProjects, name: 'username' in entity ? entity.username : entity.name, expected: this.store.hash(JSON.stringify(detail)), counts: { members: members.length, workspaces: workspaces.length, unpublished: workspaces.filter(workspace => workspace.unpublished).length, tokens: tokens.length, revisions: revisions.length, notes: notes.length, scheduledTasks: scheduledTasks.length }, drafts: workspaces.filter(workspace => workspace.unpublished).map(workspace => ({ projectId: workspace.project_id, projectName: workspace.name })), blockers };
    }
    remove(target: Target, current: { id: string; username: string }, name: string, expected: string) {
        return this.store.db.transaction(() => {
            const preview = this.preview(target, current.id);
            if (preview.expected !== expected) throw new Fault(409, '关联内容已变化，请重新查看影响范围后确认');
            if (name !== preview.name) throw new Fault(400, '确认名称不匹配');
            if (preview.blockers.length) throw new Fault(409, preview.blockers.join('；'));
            if (target.kind === 'project') {
                this.store.db.prepare('UPDATE project_lifecycle SET deleted=1,version=version+1 WHERE project_id=?').run(target.id);
                this.store.db.prepare('DELETE FROM tokens WHERE project_id=?').run(target.id);
            } else {
                const condition = target.kind === 'member' ? 'user_id=? AND project_id=?' : 'user_id=?';
                const args = target.kind === 'member' ? [target.id, target.projectId!] : [target.id];
                this.store.db.prepare('DELETE FROM tokens WHERE ' + condition).run(...args);
                this.store.db.prepare('DELETE FROM member_permissions WHERE ' + condition).run(...args);
                this.store.db.prepare('DELETE FROM members WHERE ' + condition).run(...args);
                if (target.kind === 'account') {
                    this.store.db.prepare('INSERT INTO deleted_accounts VALUES (?,?)').run(target.id, new Date().toISOString());
                    this.store.db.prepare('INSERT INTO account_access VALUES (?,0,1) ON CONFLICT(user_id) DO UPDATE SET disabled=1').run(target.id);
                    this.store.db.prepare('UPDATE users SET password=? WHERE id=?').run(passwordHash(randomUUID() + randomUUID()), target.id);
                    this.store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
                }
            }
            audit(this.store, current.username, target.kind === 'project' ? '删除项目' : target.kind === 'account' ? '删除账号' : '移出项目', target.id, { name: preview.name, projectId: target.projectId, counts: preview.counts });
            return { ok: true };
        })();
    }
    updateProject(actor: string, input: { id: string; version: number; action: 'rename' | 'archive' | 'restore'; name?: string }) {
        return this.store.db.transaction(() => {
            const project = projectState(this.store, input.id);
            if (project.version !== input.version) throw new Fault(409, '项目状态已变化，请刷新后重试');
            if (input.action === 'rename' && !input.name?.trim()) throw new Fault(400, '请填写项目名称');
            if (input.action !== 'rename' && !!project.archived === (input.action === 'archive')) throw new Fault(409, '项目状态已变化，请刷新后重试');
            if (input.action === 'archive') {
                const activity = this.activity(this.workspaces({ kind: 'project', id: input.id }));
                if (activity.sessions.length || activity.clients.length) throw new Fault(409, '存在活动写入或未保存输入，请先结束写入再归档');
            }
            const name = input.action === 'rename' ? input.name!.trim() : project.name;
            const archived = input.action === 'rename' ? project.archived : Number(input.action === 'archive');
            this.store.db.prepare('UPDATE projects SET name=? WHERE id=?').run(name, project.id);
            this.store.db.prepare('INSERT INTO project_lifecycle VALUES (?,?,0,?) ON CONFLICT(project_id) DO UPDATE SET archived=excluded.archived,version=excluded.version').run(project.id, archived, project.version + 1);
            this.store.emit(project.id, null, 'project', {});
            audit(this.store, actor, input.action === 'rename' ? '重命名项目' : input.action === 'archive' ? '归档项目' : '恢复项目', project.id, { name, previousName: project.name, archived: !!archived });
            return { ok: true };
        })();
    }
}
export function registerLifecycle(app: FastifyInstance, store: Store) {
    const lifecycle = new Lifecycle(store);
    app.post('/api/admin/projects', async request => {
        const current = administrator(store, request), input = z.object({ name: z.string().trim().min(1).max(120) }).strict().parse(request.body);
        return store.db.transaction(() => { const project = initializeProject(store, randomUUID(), input.name); audit(store, current.username, '创建项目', project.id, { name: project.name }); return project; })();
    });
    app.post('/api/admin/project', async request => {
        const current = administrator(store, request), input = z.object({ id: z.string().min(1).max(150), version: z.number().int().nonnegative(), action: z.enum(['rename', 'archive', 'restore']), name: z.string().trim().min(1).max(120).optional() }).strict().parse(request.body);
        return lifecycle.updateProject(current.username, input);
    });
    app.get('/api/admin/impact', async request => { const current = administrator(store, request); return lifecycle.preview(targetSchema.strict().parse(request.query), current.id); });
    app.post('/api/admin/remove', async request => {
        const current = administrator(store, request), input = targetSchema.extend({ name: z.string().min(1).max(120), expected: z.string().length(64) }).strict().parse(request.body);
        return lifecycle.remove(input, current, input.name, input.expected);
    });
}
