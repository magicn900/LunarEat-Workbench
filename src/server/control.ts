import { writableProject } from './projectState.js';
import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import type { Actor } from '../shared/model.js';
import { Fault, requireScope } from './auth.js';

type Session = { id: string; workspace_id: string; owner: string; task: string; status: string; expires: number; title: string };
export type WriteInput = { taskId?: string; writeSessionId?: string; title?: string };
const leaseMs = 45000;
export class Control {
    constructor(private store: Store) {
        store.db.exec('CREATE TABLE IF NOT EXISTS write_sessions(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,owner TEXT NOT NULL,task TEXT NOT NULL,status TEXT NOT NULL,expires INTEGER NOT NULL,title TEXT NOT NULL); CREATE TABLE IF NOT EXISTS web_clients(id TEXT NOT NULL,workspace_id TEXT NOT NULL,dirty INTEGER NOT NULL,seen INTEGER NOT NULL,ack TEXT,PRIMARY KEY(id,workspace_id));');
    }
    fail(code: string, message: string): never { throw new Fault(409, message, { code, retryable: false, requiredAction: code === 'CONTROL_HANDOFF_PENDING' ? 'wait_for_handoff' : 'request_new_write_session' }); }
    current(workspaceId: string) {
        this.store.db.prepare("UPDATE write_sessions SET status='expired' WHERE workspace_id=? AND status IN ('active','pending') AND expires<=?").run(workspaceId, Date.now());
        return this.store.db.prepare("SELECT * FROM write_sessions WHERE workspace_id=? AND status IN ('active','pending') ORDER BY rowid DESC LIMIT 1").get(workspaceId) as Session | undefined;
    }
    event(actor: Actor, workspaceId: string) { this.store.emit(actor.projectId, workspaceId, 'control', {}); }
    publicState(workspaceId: string) {
        const session = this.current(workspaceId);
        return session ? { id: session.id, status: session.status, title: session.title, expires: session.expires } : null;
    }
    abandonedClients(workspaceId: string) {
        return this.store.db.prepare('SELECT id,seen FROM web_clients WHERE workspace_id=? AND dirty=1 AND seen<? ORDER BY seen').all(workspaceId, Date.now()-30000) as { id: string; seen: number }[];
    }
    abandonClient(actor: Actor, workspaceId: string, input: { clientId: string; seen: number; confirm: boolean }) {
        if (actor.kind !== 'human') throw new Fault(403, '只有人工可以放弃失联页面的未保存输入');
        requireScope(actor, 'workspace.write');
        const workspace = this.store.db.prepare('SELECT user_id,project_id FROM workspaces WHERE id=?').get(workspaceId) as any;
        if (!workspace || workspace.user_id !== actor.userId || workspace.project_id !== actor.projectId) throw new Fault(403, '只能处理自己的当前项目草稿');
        if (!input.confirm) throw new Fault(400, '需要明确确认放弃失联页面的未保存输入');
        const result = this.store.db.prepare('DELETE FROM web_clients WHERE workspace_id=? AND id=? AND dirty=1 AND seen=? AND seen<?').run(workspaceId, input.clientId, input.seen, Date.now()-30000);
        if (!result.changes) throw new Fault(409, '页面状态已变化或仍在线，请刷新后重新确认');
        this.store.emit(actor.projectId, workspaceId, 'control', { abandonedClient: input.clientId, lastSeen: input.seen, actor: actor.username });
        return { ok: true };
    }
    presence(actor: Actor, workspaceId: string, input: { clientId: string; dirty: boolean; ack?: string; close?: boolean }) {
        if (actor.kind !== 'human') throw new Fault(403, '只有 Web 人工会话可以确认交接');
        const active = this.current(workspaceId);
        if (input.close && !input.dirty) this.store.db.prepare('DELETE FROM web_clients WHERE id=? AND workspace_id=?').run(input.clientId, workspaceId);
        else this.store.db.prepare('INSERT INTO web_clients VALUES (?,?,?,?,?) ON CONFLICT(id,workspace_id) DO UPDATE SET dirty=excluded.dirty,seen=excluded.seen,ack=excluded.ack').run(input.clientId, workspaceId, input.dirty ? 1 : 0, Date.now(), !input.dirty && input.ack === active?.id ? input.ack : null);
        return { control: this.publicState(workspaceId), abandonedClients: this.abandonedClients(workspaceId) };
    }
    prepare(actor: Actor, workspaceId: string, input: WriteInput, explicit = false) {
        writableProject(this.store, actor.projectId);
        requireScope(actor, 'workspace.write');
        if (actor.kind !== 'agent') {
            if (this.current(workspaceId)?.status === 'active') this.fail('WORKSPACE_LOCKED', 'Agent 正在写入，请先收回控制权');
            return null;
        }
        const current = this.current(workspaceId);
        const previous = this.store.db.prepare('SELECT * FROM write_sessions WHERE workspace_id=? AND owner=? ORDER BY rowid DESC LIMIT 1').get(workspaceId, actor.sessionId) as Session | undefined;
        let session: Session | undefined;
        if (input.writeSessionId && !explicit) {
            session = this.store.db.prepare('SELECT * FROM write_sessions WHERE id=? AND workspace_id=? AND owner=?').get(input.writeSessionId, workspaceId, actor.sessionId) as Session | undefined;
            if (!session) this.fail('WRITE_SESSION_INVALID', '写入会话不存在或不属于当前身份');
            if (session.task !== (input.taskId || actor.sessionId)) this.fail('WRITE_SESSION_INVALID', '写入会话不属于当前任务');
            if (!['active','pending'].includes(session.status)) this.fail('WRITE_SESSION_' + session.status.toUpperCase(), '写入会话已' + (session.status === 'revoked' ? '被人工收回' : '结束或超时') + '，本次写入未执行；请显式重新申请');
        } else {
            if (previous && ['revoked','expired'].includes(previous.status) && !explicit) this.fail('WRITE_SESSION_' + previous.status.toUpperCase(), '控制权已被收回或超时，省略会话 ID 不能重新取得权限，请显式申请');
            if (current) {
                if (current.owner !== actor.sessionId || current.task !== (input.taskId || actor.sessionId)) this.fail('WORKSPACE_LOCKED', '其他写入会话正在占用工作区');
                session = current;
            } else {
                session = { id: randomUUID(), workspace_id: workspaceId, owner: actor.sessionId, task: input.taskId || actor.sessionId, status: 'pending', expires: Date.now() + leaseMs, title: input.title?.slice(0,200) || 'Agent 正在修改策划' };
                this.store.db.prepare('INSERT INTO write_sessions VALUES (?,?,?,?,?,?,?)').run(session.id, workspaceId, session.owner, session.task, session.status, session.expires, session.title);
                this.event(actor, workspaceId);
            }
        }
        if (session.status === 'pending') {
            const waiting = this.store.db.prepare('SELECT 1 FROM web_clients WHERE workspace_id=? AND (dirty=1 OR (seen>? AND (ack IS NULL OR ack<>?))) LIMIT 1').get(workspaceId, Date.now()-15000, session.id);
            if (waiting) this.fail('CONTROL_HANDOFF_PENDING', '等待 Web 保存并交还控制权；当前修改尚未执行');
        }
        this.store.db.prepare("UPDATE write_sessions SET status='active',expires=? WHERE id=?").run(Date.now()+leaseMs, session.id);
        if (session.status !== 'active') this.event(actor, workspaceId);
        return session.id;
    }
    guard(actor: Actor, workspaceId: string, id: string | null) {
        const current = this.current(workspaceId);
        if (actor.kind === 'agent') {
            if(!id)this.fail('WRITE_SESSION_REQUIRED','尚未取得写入会话，请先开始写入或显式申请');
            const session=this.store.db.prepare('SELECT * FROM write_sessions WHERE id=? AND workspace_id=? AND owner=?').get(id,workspaceId,actor.sessionId) as Session|undefined;
            if(!session)this.fail('WRITE_SESSION_INVALID','写入会话不存在或不属于当前身份');
            if(!['active','pending'].includes(session.status))this.fail('WRITE_SESSION_'+session.status.toUpperCase(),'写入会话已结束、超时或被收回，本次操作未执行，请重新申请');
            if(!current || current.id!==id || current.status!=='active')this.fail('CONTROL_HANDOFF_PENDING','写入会话尚未取得控制权，请等待交接');
        } else if (current?.status === 'active') this.fail('WORKSPACE_LOCKED', 'Agent 正在写入，请先收回控制权');
    }
    action(actor: Actor, workspaceId: string, input: WriteInput & { action: 'release'|'renew'|'revoke'|'request' }) {
        writableProject(this.store, actor.projectId);
        requireScope(actor, 'workspace.write');
        if (input.action === 'request') {
            if(actor.kind !== 'agent') throw new Fault(403,'只有 Agent 可以申请写入会话');
            return { writeSessionId: this.prepare(actor, workspaceId, input, true) };
        }
        const current = this.current(workspaceId);
        if (input.action === 'revoke') {
            if (actor.kind !== 'human') throw new Fault(403, '只有人工可以收回控制权');
            if (!current || current.id !== input.writeSessionId) this.fail('WRITE_SESSION_CHANGED', '控制权已变化，请刷新后再收回');
            this.store.db.prepare("UPDATE write_sessions SET status='revoked' WHERE id=?").run(current.id);
        } else {
            if (actor.kind !== 'agent') throw new Fault(403,'只有所属 Agent 可以维护写入会话');
            const owned = this.store.db.prepare('SELECT * FROM write_sessions WHERE id=? AND workspace_id=? AND owner=?').get(input.writeSessionId || '', workspaceId, actor.sessionId) as Session | undefined;
            if (!owned || owned.task !== (input.taskId || actor.sessionId)) this.fail('WRITE_SESSION_INVALID', '写入会话不存在或不属于当前身份和任务');
            if (input.action === 'release' && ['released','expired'].includes(owned.status)) return { ok: true, released: true, previousStatus: owned.status, control: this.publicState(workspaceId) };
            this.guard(actor, workspaceId, input.writeSessionId || null);
            this.store.db.prepare('UPDATE write_sessions SET status=?,expires=? WHERE id=?').run(input.action === 'release' ? 'released' : 'active', Date.now()+leaseMs, current!.id);
        }
        this.event(actor, workspaceId);
        return { ok: true, control: this.publicState(workspaceId) };
    }
}
