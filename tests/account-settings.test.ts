import { beforeAll, afterAll, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { createCodec, type Codec } from '../src/server/codec.js';
import { createApp } from '../src/server/app.js';
import { Service } from '../src/server/service.js';
import { seed } from '../src/server/seed.js';
import { createUser, passwordHash } from '../src/server/auth.js';
let store: Store, codec: Codec, app: Awaited<ReturnType<typeof createApp>>, directory: string, cookie: string, otherCookie: string, userId: string;
const headers = () => ({ cookie, 'x-workbench-client': 'test' });
const post = (path: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api' + path, headers: headers(), payload });
const prefs = async () => (await app.inject({ url: '/api/identity', headers: headers() })).json().preferences;
const login = async (username: string, password = 'account-test-password') => (await app.inject({ method: 'POST', url: '/api/login', headers: { 'x-workbench-client': 'test' }, payload: { username, password } })).headers['set-cookie']!.toString().split(';')[0];
beforeAll(async () => { directory = mkdtempSync(join(tmpdir(), 'workbench-settings-')); store = new Store(directory); seed(store, 'account-test-password'); userId = createUser(store, 'settings-owner', 'account-test-password', 'demo'); codec = await createCodec(); app = await createApp(new Service(store, codec)); cookie = await login('settings-owner'); otherCookie = await login('designer'); }, 30000);
afterAll(async () => { await app?.close(); await codec?.close(); store?.close(); if (directory?.startsWith(join(tmpdir(), 'workbench-settings-'))) rmSync(directory, { recursive: true, force: true }); });
it('旧账号默认跟随系统和中文，不写入设计数据', async () => { expect(await prefs()).toEqual({ theme: 'system', language: 'zh-CN', version: 0, shortcuts: {} }); expect(store.db.prepare('SELECT * FROM account_preferences').all()).toEqual([]); });
it('偏好保存不改变草稿、事件、版本和其他账号', async () => {
    const before = (await app.inject({ url: '/api/workspace', headers: headers() })).json();
    expect((await post('/account/preferences', { theme: 'dark', language: 'en', version: 0 })).statusCode).toBe(200);
    expect(await prefs()).toEqual({ theme: 'dark', language: 'en', version: 1, shortcuts: {} });
    const after = (await app.inject({ url: '/api/workspace', headers: headers() })).json();
    expect(after.workspace).toEqual(before.workspace); expect(after.tree).toEqual(before.tree); expect(after.seq).toBe(before.seq); expect(after.main).toBe(before.main);
    expect((await app.inject({ url: '/api/identity', headers: { cookie: otherCookie } })).json().preferences.version).toBe(0);
});
it('跨登录保留偏好，拒绝旧版本覆盖和非法语言', async () => {
    cookie = await login('settings-owner'); expect((await prefs()).language).toBe('en');
    expect((await post('/account/preferences', { theme: 'light', language: 'zh-CN', version: 0 })).statusCode).toBe(409);
    expect((await post('/account/preferences', { theme: 'dark', language: 'fake', version: 1 })).statusCode).toBe(400);
    expect((await post('/account/preferences', { theme: 'dark', language: 'en', version: 1, userId: 'other' })).statusCode).toBe(400);
});
it('无项目账号可以管理偏好', async () => {
    store.db.prepare('INSERT INTO users VALUES (?,?,?)').run('no-project', 'no-project', passwordHash('account-test-password'));
    const independent = await login('no-project');
    expect((await app.inject({ method: 'POST', url: '/api/account/preferences', headers: { cookie: independent, 'x-workbench-client': 'test' }, payload: { theme: 'light', language: 'en', version: 0 } })).statusCode).toBe(200);
});
it('未登录、Agent 和跨站调用不能更改本人设置或密码', async () => {
    const token = (await post('/tokens', { name: 'settings-agent', scopes: ['workspace.read', 'workspace.write'] })).json().token;
    for (const path of ['/account/preferences', '/account/password']) {
        expect((await app.inject({ method: 'POST', url: '/api' + path, headers: { 'x-workbench-client': 'test' }, payload: {} })).statusCode).toBe(401);
        expect((await app.inject({ method: 'POST', url: '/api' + path, headers: { authorization: 'Bearer ' + token }, payload: {} })).statusCode).toBe(403);
        expect((await app.inject({ method: 'POST', url: '/api' + path, headers: { ...headers(), origin: 'https://evil.example' }, payload: {} })).statusCode).toBe(403);
    }
});
it('错误旧密码或相同新密码不撤销会话，且不能指定他人账号', async () => {
    expect((await post('/account/password', { currentPassword: 'wrong-password', newPassword: 'new-account-password' })).statusCode).toBe(400);
    expect((await post('/account/password', { currentPassword: 'account-test-password', newPassword: 'account-test-password' })).statusCode).toBe(400);
    expect((await post('/account/password', { currentPassword: 'account-test-password', newPassword: 'new-account-password', userId: 'other' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/identity', headers: headers() })).statusCode).toBe(200);
});
it('改密撤销该账号所有会话和凭据，保留其他账号与草稿', async () => {
    const secondSession = await login('settings-owner');
    const token = (await post('/tokens', { name: 'password-agent', scopes: ['workspace.read', 'workspace.write'] })).json().token;
    const lease = await app.inject({ method: 'POST', url: '/api/workspace/control', headers: { authorization: 'Bearer ' + token }, payload: { action: 'request', taskId: 'password-change-test' } });
    expect(lease.statusCode).toBe(200);
    expect(store.db.prepare("SELECT count(*) AS count FROM write_sessions WHERE status='active'").get()).toEqual({ count: 1 });
    const before = store.db.prepare('SELECT * FROM workspaces WHERE user_id=?').all(userId);
    const response = await post('/account/password', { currentPassword: 'account-test-password', newPassword: 'new-account-password' }); expect(response.statusCode).toBe(200);
    expect(store.db.prepare("SELECT count(*) AS count FROM write_sessions WHERE status='active'").get()).toEqual({ count: 0 });
    for (const session of [cookie, secondSession]) expect((await app.inject({ url: '/api/identity', headers: { cookie: session } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/workspace', headers: { authorization: 'Bearer ' + token } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/identity', headers: { cookie: otherCookie } })).statusCode).toBe(200);
    expect(store.db.prepare('SELECT * FROM workspaces WHERE user_id=?').all(userId)).toEqual(before);
    const audit = JSON.stringify(store.db.prepare('SELECT * FROM admin_audit').all()); expect(audit).not.toContain('new-account-password'); expect(audit).not.toContain(token);
    cookie = await login('settings-owner', 'new-account-password'); expect((await prefs()).language).toBe('en');
});
it('本人密码验证限流', async () => { for (let attempt = 0; attempt < 6; attempt++) { const response = await post('/account/password', { currentPassword: 'wrong-password', newPassword: 'another-password' }); if (attempt === 5) expect(response.statusCode).toBe(429); } });
it('快捷键随账号保存且旧客户端省略字段时不清空，冲突与非法绑定被拒绝', async () => {
    const before = await prefs();
    const other = (await app.inject({ url: '/api/identity', headers: { cookie: otherCookie } })).json().preferences;
    const saved = await post('/account/preferences', { ...before, shortcuts: { bold: 'Mod+Shift+B', highlight: 'Mod+Alt+H' } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await prefs()).shortcuts).toEqual({ bold: 'Mod+Shift+B', highlight: 'Mod+Alt+H' });
    const current = await prefs();
    expect((await post('/account/preferences', { theme: current.theme, language: current.language, version: current.version })).statusCode).toBe(200);
    expect((await prefs()).shortcuts).toEqual(current.shortcuts);
    expect((await post('/account/preferences', { ...await prefs(), shortcuts: { highlight: 'Mod+B' } })).statusCode).toBe(422);
    expect((await post('/account/preferences', { ...await prefs(), shortcuts: { highlight: 'Mod+W' } })).statusCode).toBe(422);
    expect((await app.inject({ url: '/api/identity', headers: { cookie: otherCookie } })).json().preferences).toEqual(other);
});
