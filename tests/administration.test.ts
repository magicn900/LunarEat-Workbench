import { beforeAll, afterAll, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/server/store.js';
import { createCodec, type Codec } from '../src/server/codec.js';
import { Service } from '../src/server/service.js';
import { createApp } from '../src/server/app.js';
import { seed } from '../src/server/seed.js';
import { actorFor, passwordHash, memberScopes } from '../src/server/auth.js';
import { updateAccountAccess } from '../src/server/administration.js';
import { capabilities } from '../src/shared/permissions.js';

let store: Store, codec: Codec, app: Awaited<ReturnType<typeof createApp>>, directory: string, adminSession: string, designerSession: string;
const password = 'administration-test-password';
const headers = (cookie = adminSession) => ({ cookie, 'x-workbench-client': 'test' });
const post = (path: string, payload: any, cookie = adminSession) => {
    if (path === '/admin/account' && payload.userId && !payload.expected) {
        const before = store.db.prepare('SELECT * FROM account_access WHERE user_id=?').get(payload.userId) as any;
        payload.expected = { administrator: !!before?.administrator, disabled: !!before?.disabled };
    }
    if (path === '/admin/member' && payload.userId && !('expectedScopes' in payload)) {
        const member = store.db.prepare('SELECT * FROM members WHERE user_id=? AND project_id=?').get(payload.userId, payload.projectId);
        payload.expectedScopes = member ? memberScopes(store, member) : null;
    }
    return app.inject({ method: 'POST', url: '/api' + path, headers: headers(cookie), payload });
};
async function login(username: string) {
    const response = await post('/login', { username, password }, '');
    expect(response.statusCode).toBe(200);
    return response.headers['set-cookie']!.toString().split(';')[0];
}
async function createMember(name: string, scopes = capabilities) {
    const response = await post('/admin/users', { username: name, password });
    expect(response.statusCode).toBe(200);
    const id = response.json().id;
    expect((await post('/admin/member', { userId: id, projectId: 'demo', scopes })).statusCode).toBe(200);
    return { id, session: await login(name) };
}
beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-admin-test-'));
    store = new Store(directory); seed(store, password);
    store.db.prepare('INSERT INTO users VALUES (?,?,?)').run('root', 'platform-owner', passwordHash(password));
    store.db.transaction(() => updateAccountAccess(store, '本机管理员', 'root', true, false))();
    codec = await createCodec(); app = await createApp(new Service(store, codec));
    adminSession = await login('platform-owner'); designerSession = await login('designer');
}, 30000);
afterAll(async () => { await app?.close(); await codec?.close(); store?.close(); if (directory?.startsWith(join(tmpdir(), 'workbench-admin-test-'))) rmSync(directory, { recursive: true, force: true }); });

it('旧账号保持原有能力，没有自动成为管理员', async () => {
    const snapshot = (await app.inject({ url: '/api/workspace', headers: headers(designerSession) })).json();
    expect(snapshot.actor.scopes).toEqual(capabilities.filter(scope => scope !== 'design.sync'));
    expect((await app.inject({ url: '/api/identity', headers: headers(designerSession) })).json().administrator).toBe(false);
    const developer = store.db.prepare('SELECT * FROM users WHERE username=?').get('developer') as any;
    expect((store.db.prepare('SELECT * FROM account_access WHERE user_id=?').get(developer.id))).toBeUndefined();
});
it('管理接口拒绝未登录、普通成员、Agent 与跨站写入', async () => {
    expect((await app.inject('/api/admin')).statusCode).toBe(401);
    for (const path of ['/admin', '/admin/audit']) expect((await app.inject({ url: '/api' + path, headers: headers(designerSession) })).statusCode).toBe(403);
    for (const path of ['/admin/users', '/admin/account', '/admin/password', '/admin/member', '/admin/token/revoke']) expect((await post(path, {}, designerSession)).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/admin', headers: { ...headers(), authorization: 'Bearer not-a-human-session' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/admin/users', headers: { ...headers(), origin: 'https://untrusted.example' }, payload: {} })).statusCode).toBe(403);
});
it('平台管理员不需要项目成员身份，也不会自动获得业务权限', async () => {
    expect((await app.inject({ url: '/api/admin', headers: headers() })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/identity', headers: headers() })).json().projects).toEqual([]);
    expect((await app.inject({ url: '/api/workspace', headers: headers() })).statusCode).toBe(403);
});
it('新账号默认没有项目权限，拒绝重复账号和不完整依赖', async () => {
    const response = await post('/admin/users', { username: 'new-member', password });
    expect(response.statusCode).toBe(200);
    expect((await post('/admin/users', { username: 'new-member', password })).statusCode).toBe(409);
    const cookie = await login('new-member');
    expect((await app.inject({ url: '/api/identity', headers: headers(cookie) })).json().projects).toEqual([]);
    expect((await post('/admin/member', { userId: response.json().id, projectId: 'demo', scopes: ['design.publish'] })).statusCode).toBe(400);
    expect((await post('/admin/member', { userId: response.json().id, projectId: 'missing', scopes: [] })).statusCode).toBe(404);
});
it('只读成员的写入被后端拒绝，不能靠直接接口绕过', async () => {
    const member = await createMember('reader', ['workspace.read']);
    const snapshot = (await app.inject({ url: '/api/workspace', headers: headers(member.session) })).json();
    expect(snapshot.actor.scopes).toEqual(['workspace.read']);
    expect((await post('/workspace/operations', { requestId: randomUUID(), operations: [{ type: 'field', id: 'frost', key: 'cost', expected: 1, value: 2 }] }, member.session)).statusCode).toBe(403);
    expect((await post('/publish', { requestId: randomUUID(), head: snapshot.workspace.head, main: snapshot.main, title: '不能发布' }, member.session)).statusCode).toBe(403);
    expect((await post('/changes/confirm', { requestId: randomUUID(), ids: ['missing'], repository: 'test', commit: 'test', note: 'test', active: true }, member.session)).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/inspiration', headers: headers(member.session) })).statusCode).toBe(403);
});
it('撤回权限后旧 Agent 凭据立即受限，重新授权不会复活被收回的能力', async () => {
    const member = await createMember('agent-owner');
    const response = await post('/tokens', { name: 'agent', scopes: capabilities }, member.session);
    expect(response.statusCode).toBe(200);
    const token = response.json().token;
    const snapshot = (await app.inject({ url: '/api/workspace', headers: headers(member.session) })).json();
    const cost = snapshot.tree.frost.fields.cost;
    const firstWrite = await app.inject({ method: 'POST', url: '/api/workspace/operations', headers: { authorization: 'Bearer ' + token }, payload: { taskId: 'same-task', requestId: randomUUID(), operations: [{ type: 'field', id: 'frost', key: 'cost', expected: cost, value: cost + 1 }] } });
    expect(firstWrite.statusCode).toBe(200);
    expect(firstWrite.json().writeSessionId).toBeTruthy();
    const authenticate = () => actorFor(store, token, true);
    expect(authenticate().scopes).toContain('workspace.write');
    await post('/admin/member', { userId: member.id, projectId: 'demo', scopes: ['workspace.read'] });
    expect(authenticate().scopes).toEqual(['workspace.read']);
    const denied = await app.inject({ method: 'POST', url: '/api/workspace/operations', headers: { authorization: 'Bearer ' + token }, payload: { taskId: 'same-task', writeSessionId: firstWrite.json().writeSessionId, requestId: randomUUID(), operations: [{ type: 'field', id: 'frost', key: 'cost', expected: cost + 1, value: cost + 2 }] } });
    expect(denied.statusCode).toBe(403);
    await post('/admin/member', { userId: member.id, projectId: 'demo', scopes: capabilities });
    expect(authenticate().scopes).toEqual(['workspace.read']);
    expect((await post('/tokens', { name: 'escalation', scopes: ['platform.admin'] }, member.session)).statusCode).toBe(400);
});
it('旧管理页面不能覆盖已改变的账号状态或项目权限', async () => {
    const member = await createMember('stale-member', ['workspace.read']);
    expect((await post('/admin/member', { userId: member.id, projectId: 'demo', scopes: [], expectedScopes: ['workspace.read'] })).statusCode).toBe(200);
    expect((await post('/admin/member', { userId: member.id, projectId: 'demo', scopes: capabilities, expectedScopes: ['workspace.read'] })).statusCode).toBe(409);
    expect((await post('/admin/account', { userId: member.id, administrator: false, disabled: true, expected: { administrator: false, disabled: false } })).statusCode).toBe(200);
    expect((await post('/admin/account', { userId: member.id, administrator: true, disabled: false, expected: { administrator: false, disabled: false } })).statusCode).toBe(409);
});
it('不能停用或降级最后一位管理员，失败时事务回滚', async () => {
    for (const flags of [{ administrator: false, disabled: false }, { administrator: true, disabled: true }]) {
        expect((await post('/admin/account', { userId: 'root', ...flags })).statusCode).toBe(409);
        expect((await app.inject({ url: '/api/admin', headers: headers() })).statusCode).toBe(200);
    }
});
it('停用账号撤销会话和凭据，但保留草稿；重新启用不恢复旧会话', async () => {
    const member = await createMember('disabled-member');
    const before = (await app.inject({ url: '/api/workspace', headers: headers(member.session) })).json();
    const token = (await post('/tokens', { name: 'agent', scopes: ['workspace.read'] }, member.session)).json().token;
    expect((await post('/admin/account', { userId: member.id, administrator: false, disabled: true })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/workspace', headers: headers(member.session) })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/workspace', headers: { authorization: 'Bearer ' + token } })).statusCode).toBe(401);
    expect((await post('/login', { username: 'disabled-member', password }, '')).statusCode).toBe(401);
    expect((store.db.prepare('SELECT head FROM workspaces WHERE id=?').get(before.workspace.id) as any).head).toBe(before.workspace.head);
    await post('/admin/account', { userId: member.id, administrator: false, disabled: false });
    expect((await app.inject({ url: '/api/workspace', headers: headers(member.session) })).statusCode).toBe(401);
});
it('重置密码和撤销凭据可验证失效，管理响应与审计不泄露秘密', async () => {
    const member = await createMember('reset-member');
    const token = (await post('/tokens', { name: 'reset-agent', scopes: ['workspace.read'] }, member.session)).json();
    const overview = await app.inject({ url: '/api/admin', headers: headers() });
    expect(overview.body).not.toContain(token.token);
    expect(overview.body).not.toContain('password');
    expect((await post('/admin/token/revoke', { id: token.id })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/workspace', headers: { authorization: 'Bearer ' + token.token } })).statusCode).toBe(401);
    const replacement = 'replacement-password-123';
    expect((await post('/admin/password', { userId: member.id, password: replacement })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/identity', headers: headers(member.session) })).statusCode).toBe(401);
    const records = await app.inject({ url: '/api/admin/audit', headers: headers() });
    expect(records.body).not.toContain(replacement); expect(records.body).not.toContain(token.token);
    expect(records.json().some((record: any) => record.action === '重置密码并撤销凭据')).toBe(true);
    const next = await app.inject({ url: '/api/admin/audit?before=' + records.json().at(-1).id, headers: headers() });
    expect(next.json()).toEqual([]);
});
