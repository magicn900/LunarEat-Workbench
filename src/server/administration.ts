import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from './store.js';
import { accountAccess, accountPreferences, Fault, memberScopes, passwordHash } from './auth.js';
import { effectiveProjectScopes, projectState, visibleProjects } from './projectState.js';
import { capabilities, permissionDependencies } from '../shared/permissions.js';

const identifier = z.string().min(1).max(150);
const username = z.string().trim().min(1).max(80).regex(/^[\p{L}\p{N}_.@-]+$/u);
const password = z.string().min(10).max(1024);
const scopesSchema = z.array(z.enum(capabilities as [string, ...string[]])).max(capabilities.length).refine(scopes => new Set(scopes).size === scopes.length && scopes.every(scope => (permissionDependencies[scope] || []).every(required => scopes.includes(required))), '请同时授予依赖的查看或编辑权限');

export function identity(store: Store, request: any) {
    if (request.headers.authorization) throw new Fault(403, '管理入口仅接受人工登录');
    const user = store.db.prepare('SELECT u.id,u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires>?').get(store.hash(request.cookies.session || ''), Date.now()) as any;
    if (!user) throw new Fault(401, '请先登录');
    const access = accountAccess(store, user.id);
    const projects = (store.db.prepare('SELECT m.*,p.name FROM members m JOIN projects p ON p.id=m.project_id WHERE user_id=? AND NOT EXISTS (SELECT 1 FROM project_lifecycle s WHERE s.project_id=p.id AND s.deleted=1) ORDER BY project_id').all(user.id) as any[]).map(member => ({ id: member.project_id, name: member.name, archived: !!projectState(store, member.project_id).archived, scopes: effectiveProjectScopes(store, member.project_id, memberScopes(store, member)) }));
    return { ...user, ...access, projects, preferences: accountPreferences(store, user.id) };
}

export function audit(store: Store, actor: string, action: string, target: string, details: unknown) {
    store.db.prepare('INSERT INTO admin_audit(actor,action,target,details,created) VALUES (?,?,?,?,?)').run(actor, action, target, JSON.stringify(details), new Date().toISOString());
}

export function updateAccountAccess(store: Store, actor: string, userId: string, administrator: boolean, disabled: boolean) {
    if (store.db.prepare('SELECT user_id FROM deleted_accounts WHERE user_id=?').get(userId)) throw new Fault(404, '账号已删除');
    if (!store.db.prepare('SELECT id FROM users WHERE id=?').get(userId)) throw new Fault(404, '账号不存在');
    store.db.prepare('INSERT INTO account_access VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET administrator=excluded.administrator,disabled=excluded.disabled').run(userId, Number(administrator), Number(disabled));
    if (!(store.db.prepare('SELECT COUNT(*) AS count FROM account_access WHERE administrator=1 AND disabled=0').get() as any).count) throw new Fault(409, '必须保留至少一个可用的平台管理员');
    if (disabled) {
        store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
        store.db.prepare('DELETE FROM tokens WHERE user_id=?').run(userId);
    }
    audit(store, actor, '调整账号', userId, { administrator, disabled });
}

export function administrator(store: Store, request: any) {
    const current = identity(store, request);
    if (!current.administrator) throw new Fault(403, '仅平台管理员可以执行此操作');
    return current;
}

export function registerAdministration(app: FastifyInstance, store: Store) {
    const admin = (request: any) => administrator(store, request);
    app.get('/api/identity', async request => identity(store, request));
    app.get('/api/admin', async request => {
        admin(request);
        return {
            users: store.db.prepare('SELECT u.id,u.username,COALESCE(a.administrator,0) AS administrator,COALESCE(a.disabled,0) AS disabled FROM users u LEFT JOIN account_access a ON a.user_id=u.id WHERE NOT EXISTS (SELECT 1 FROM deleted_accounts d WHERE d.user_id=u.id) ORDER BY u.username').all(),
            projects: visibleProjects(store),
            members: (store.db.prepare('SELECT m.* FROM members m WHERE NOT EXISTS (SELECT 1 FROM project_lifecycle s WHERE s.project_id=m.project_id AND s.deleted=1)').all() as any[]).map(member => ({ userId: member.user_id, projectId: member.project_id, scopes: memberScopes(store, member) })),
            tokens: (store.db.prepare('SELECT t.id,t.user_id AS userId,t.project_id AS projectId,t.name,t.scopes,t.created,u.username FROM tokens t JOIN users u ON u.id=t.user_id ORDER BY t.created DESC').all() as any[]).map(token => ({ ...token, scopes: JSON.parse(token.scopes) }))
        };
    });
    app.get('/api/admin/audit', async request => {
        admin(request);
        const { before } = z.object({ before: z.coerce.number().int().positive().optional() }).parse(request.query);
        return store.db.prepare('SELECT * FROM admin_audit WHERE id<? ORDER BY id DESC LIMIT 50').all(before || Number.MAX_SAFE_INTEGER);
    });
    app.post('/api/admin/users', async request => {
        const current = admin(request), input = z.object({ username, password }).parse(request.body);
        return store.db.transaction(() => {
            if (store.db.prepare('SELECT id FROM users WHERE username=?').get(input.username)) throw new Fault(409, '账号名称已存在');
            const id = randomUUID();
            store.db.prepare('INSERT INTO users VALUES (?,?,?)').run(id, input.username, passwordHash(input.password));
            audit(store, current.username, '创建账号', id, { username: input.username });
            return { id };
        })();
    });
    app.post('/api/admin/account', async request => {
        const current = admin(request), input = z.object({ userId: identifier, administrator: z.boolean(), disabled: z.boolean(), expected: z.object({ administrator: z.boolean(), disabled: z.boolean() }) }).parse(request.body);
        store.db.transaction(() => {
            const before = store.db.prepare('SELECT administrator,disabled FROM account_access WHERE user_id=?').get(input.userId) as any;
            if (!!before?.administrator !== input.expected.administrator || !!before?.disabled !== input.expected.disabled) throw new Fault(409, '账号状态已被其他管理员修改，请重新加载后确认');
            updateAccountAccess(store, current.username, input.userId, input.administrator, input.disabled);
        })();
        return { ok: true };
    });
    app.post('/api/admin/password', async request => {
        const current = admin(request), input = z.object({ userId: identifier, password }).parse(request.body);
        store.db.transaction(() => {
            if (store.db.prepare('SELECT user_id FROM deleted_accounts WHERE user_id=?').get(input.userId)) throw new Fault(404, '账号已删除');
            if (!store.db.prepare('UPDATE users SET password=? WHERE id=?').run(passwordHash(input.password), input.userId).changes) throw new Fault(404, '账号不存在');
            store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(input.userId);
            store.db.prepare('DELETE FROM tokens WHERE user_id=?').run(input.userId);
            audit(store, current.username, '重置密码并撤销凭据', input.userId, {});
        })();
        return { ok: true };
    });
    app.post('/api/admin/member', async request => {
        const current = admin(request), input = z.object({ userId: identifier, projectId: identifier, scopes: scopesSchema, expectedScopes: z.array(z.string()).nullable() }).parse(request.body);
        store.db.transaction(() => {
            if (!store.db.prepare('SELECT id FROM users WHERE id=?').get(input.userId) || !store.db.prepare('SELECT id FROM projects WHERE id=?').get(input.projectId)) throw new Fault(404, '账号或项目不存在');
            projectState(store, input.projectId);
            if (store.db.prepare('SELECT user_id FROM deleted_accounts WHERE user_id=?').get(input.userId)) throw new Fault(404, '账号已删除');
            const existing = store.db.prepare('SELECT * FROM members WHERE user_id=? AND project_id=?').get(input.userId, input.projectId);
            const before = existing ? memberScopes(store, existing) : [];
            if (JSON.stringify(existing ? [...before].sort() : null) !== JSON.stringify(input.expectedScopes ? [...input.expectedScopes].sort() : null)) throw new Fault(409, '项目权限已被其他管理员修改，请重新加载后确认');
            store.db.prepare('INSERT INTO members VALUES (?,?,?) ON CONFLICT(user_id,project_id) DO UPDATE SET can_sync=excluded.can_sync').run(input.userId, input.projectId, Number(input.scopes.includes('design.sync')));
            store.db.prepare('INSERT INTO member_permissions VALUES (?,?,?) ON CONFLICT(user_id,project_id) DO UPDATE SET scopes=excluded.scopes').run(input.userId, input.projectId, JSON.stringify(input.scopes));
            for (const token of store.db.prepare('SELECT id,scopes FROM tokens WHERE user_id=? AND project_id=?').all(input.userId, input.projectId) as any[]) {
                store.db.prepare('UPDATE tokens SET scopes=? WHERE id=?').run(JSON.stringify(JSON.parse(token.scopes).filter((scope: string) => input.scopes.includes(scope))), token.id);
            }
            audit(store, current.username, existing ? '调整项目权限' : '加入项目', input.userId, { projectId: input.projectId, before, after: input.scopes });
        })();
        return { ok: true };
    });
    app.post('/api/admin/token/revoke', async request => {
        const current = admin(request), { id } = z.object({ id: identifier }).parse(request.body);
        store.db.transaction(() => {
            const token = store.db.prepare('SELECT user_id,project_id,name FROM tokens WHERE id=?').get(id);
            if (!token) throw new Fault(404, '凭据已不存在');
            store.db.prepare('DELETE FROM tokens WHERE id=?').run(id);
            audit(store, current.username, '撤销 Agent 凭据', id, token);
        })();
        return { ok: true };
    });
}
