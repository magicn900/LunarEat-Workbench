import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Store } from '../src/server/store.js';
import { Service } from '../src/server/service.js';
import { seed } from '../src/server/seed.js';
import { createCodec } from '../src/server/codec.js';
import { createApp } from '../src/server/app.js';
import { actorFor, issueToken } from '../src/server/auth.js';
import { BoundedCache } from '../src/server/cache.js';
import type { Actor, DesignObject } from '../src/shared/model.js';
let directory: string, store: Store, service: Service, actor: Actor, cookie: string;
let codec: Awaited<ReturnType<typeof createCodec>>, app: Awaited<ReturnType<typeof createApp>>;
beforeAll(async () => { codec = await createCodec(); });
afterAll(async () => { await codec.close(); });
beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-performance-'));
    store = new Store(directory); seed(store, 'isolated-performance-password'); service = new Service(store, codec);
    const user = store.db.prepare("SELECT id FROM users WHERE username='designer'").get() as { id: string };
    const token = randomUUID(); cookie = 'session=' + token;
    store.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(store.hash(token), user.id, Date.now() + 600000);
    actor = actorFor(store, token, false, 'demo'); app = await createApp(service);
});
afterEach(async () => { vi.restoreAllMocks(); await app.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
const headers = () => ({ cookie, 'x-workbench-client': 'test' });
const modify = (value: number) => service.mutate(actor, randomUUID(), [{ type: 'field', id: 'frost', key: 'cost', expected: (store.entity(service.workspace(actor).head, 'frost') as DesignObject).fields.cost, value }]);
const input = () => { const preview = service.preview(actor); return { requestId: randomUUID(), head: preview.head, main: preview.main, title: '性能回归', description: '' }; };
function pauseCommit() {
    let resume!: () => void, began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const original = store.commitAsync.bind(store);
    vi.spyOn(store, 'commitAsync').mockImplementation(async (...args) => { began(); await gate; return original(...args); });
    return { resume, started };
}
it('缓存受容量限制且读取不污染内容，回滚清单不能从缓存复活', () => {
    const cache = new BoundedCache<number>(10); cache.set('first', 1, 6); cache.set('second', 2, 6);
    expect(cache.get('first')).toBeUndefined(); expect(cache.get('second')).toBe(2);
    cache.set('oversized', 3, 11); expect(cache.get('oversized')).toBeUndefined();
    const head = service.workspace(actor).head; const first = store.tree(head); (first.frost as DesignObject).fields.cost = 99;
    expect((store.entity(head, 'frost') as DesignObject).fields.cost).toBe(2);
    let rolledBack = '';
    expect(() => store.db.transaction(() => { rolledBack = store.putTree(first, head); store.manifest(rolledBack); throw Error('rollback'); })()).toThrow('rollback');
    expect(() => store.tree(rolledBack)).toThrow('内容树不存在');
});
it('单文档读取不加载整树，小修改只改变目标对象哈希', () => {
    const head = service.workspace(actor).head; const spy = vi.spyOn(store, 'tree');
    service.document(actor, 'frost'); expect(spy).not.toHaveBeenCalled();
    modify(4); expect(spy).not.toHaveBeenCalled(); expect(store.changed(head, service.workspace(actor).head)).toEqual(['frost']);
});
it('差量只返回变化对象，跨账号与伪造游标回退到完整快照', () => {
    const initial = service.snapshot(actor); modify(4);
    const delta = service.snapshot(actor, initial.cursor); expect(delta.delta).toBe(true); expect(Object.keys(delta.tree)).toEqual(['frost']);
    expect(service.snapshot(actor, delta.cursor).tree).toEqual({});
    const another = store.db.prepare("SELECT id FROM users WHERE username='developer'").get() as { id: string };
    expect(service.snapshot({ ...actor, userId: another.id }, initial.cursor).delta).toBe(false);
    expect(service.snapshot(actor, initial.cursor + 'bad').delta).toBe(false);
    expect(new Service(store, codec).snapshot(actor, initial.cursor).delta).toBe(false);
});
it('删除与撤销通过同一差量协议恢复完整内容', () => {
    const initial = service.snapshot(actor), entity = initial.tree.spark;
    service.mutate(actor, randomUUID(), [{ type: 'delete', id: entity.id, expected: entity }], 'delete-spark');
    const removed = service.snapshot(actor, initial.cursor); expect(removed.removed).toEqual(['spark']);
    service.undo(actor, randomUUID(), 'delete-spark'); expect(service.snapshot(actor, removed.cursor).tree.spark).toEqual(entity);
});
it('发布准备期间健康检查可响应，草稿改变则拒绝旧发布', async () => {
    modify(3); const originalMain = store.main('demo'); const barrier = pauseCommit();
    const publishing = app.inject({ method: 'POST', url: '/api/publish', headers: headers(), payload: input() });
    await barrier.started;
    try { expect((await app.inject('/api/health')).statusCode).toBe(200); expect(store.main('demo')).toBe(originalMain); modify(4); }
    finally { barrier.resume(); }
    expect((await publishing).statusCode).toBe(409); expect(store.main('demo')).toBe(originalMain);
});
it('发布准备结束后重新校验登录凭据', async () => {
    modify(3); const originalMain = store.main('demo'); const barrier = pauseCommit();
    const publishing = app.inject({ method: 'POST', url: '/api/publish', headers: headers(), payload: input() });
    await barrier.started; store.db.prepare('DELETE FROM sessions').run(); barrier.resume();
    expect((await publishing).statusCode).toBe(401); expect(store.main('demo')).toBe(originalMain);
});
it('Agent 发布过程中被收回控制权，不会继续发布', async () => {
    modify(3); const token = issueToken(store, actor, 'publish-test', ['workspace.read', 'workspace.write', 'design.publish']).token;
    const agentHeaders = { authorization: 'Bearer ' + token };
    const review = (await app.inject({ method: 'POST', url: '/api/agent/versions', headers: agentHeaders, payload: { action: 'review' } })).json();
    const barrier = pauseCommit(), originalMain = store.main('demo');
    const publishing = app.inject({ method: 'POST', url: '/api/agent/versions', headers: agentHeaders, payload: { action: 'publish', review: review.review, title: '测试发布', requestId: randomUUID(), taskId: 'publish-task' } });
    await barrier.started;
    try { service.control.action(actor, service.workspace(actor).id, { action: 'revoke', writeSessionId: service.control.current(service.workspace(actor).id)?.id }); } finally { barrier.resume(); }
    expect((await publishing).statusCode).toBe(409); expect(store.main('demo')).toBe(originalMain);
});
it('HTTP 发布中断保留恢复记录，批量 Git 保留中文路径和内容', async () => {
    modify(3); const payload = input(); const finish = service.finishPublication.bind(service);
    vi.spyOn(service, 'finishPublication').mockImplementationOnce(() => { throw Error('interrupted'); });
    expect((await app.inject({ method: 'POST', url: '/api/publish', headers: headers(), payload })).statusCode).toBe(500);
    expect(store.db.prepare("SELECT * FROM publications WHERE state='prepared'").get()).toBeTruthy();
    service.finishPublication = finish; service.recover();
    const response = await app.inject({ method: 'POST', url: '/api/publish', headers: headers(), payload }); expect(response.statusCode).toBe(200);
    expect(store.git('demo', ['show', response.json().revision + ':技能/frost.md'])).toContain('cost: 3');
    expect(store.git('demo', ['for-each-ref', 'refs/workbench-staging'])).toBe('');
});
it('局部更新仍拒绝非法字段、结构变更和批次后半段冲突', () => {
    const head = service.workspace(actor).head;
    expect(() => service.mutate(actor, randomUUID(), [{ type: 'field', id: 'frost', key: 'cost', expected: 2, value: 'invalid' }])).toThrow('校验失败');
    expect(() => service.mutate(actor, randomUUID(), [{ type: 'field', id: 'frost', key: 'cost', expected: 2, value: 7 }, { type: 'field', id: 'guard', key: 'cost', expected: 99, value: 8 }])).toThrow('字段已被修改');
    expect(service.workspace(actor).head).toBe(head);
    const frost = store.entity(head, 'frost')!;
    expect(() => store.updateObjects(head, { frost: { ...frost, path: 'other.md' } })).toThrow('不能修改对象结构');
});
it('事件过滤发生在分页之前，不被大量无权限灵感事件阻塞', () => {
    const workspace = service.workspace(actor), since = service.sequence();
    store.db.transaction(() => { for (let index = 0; index < 550; index++) store.emit(actor.projectId, null, 'inspiration', { id: index }); store.emit(actor.projectId, workspace.id, 'workspace', { head: workspace.head }); })();
    const events = service.events({ ...actor, scopes: ['workspace.read'] }, since);
    expect(events.map(event => event.kind)).toEqual(['workspace']);
});
it('WebSocket 在提交后收到变更，回滚事件不会泄露', async () => {
    await app.ready(); const socket = await app.injectWS('/events?since=' + service.sequence(), { headers: headers() });
    const received: any[] = []; socket.on('message', data => received.push(JSON.parse(data.toString())));
    try {
        const changed = once(socket, 'message'); modify(4); await changed;
        expect(received[0].kind).toBe('workspace');
        const before = received.length;
        expect(() => store.db.transaction(() => { store.emit(actor.projectId, service.workspace(actor).id, 'workspace', { invalid: true }); throw Error('rollback'); })()).toThrow('rollback');
        await new Promise(resolve => setImmediate(resolve)); expect(received).toHaveLength(before);
    } finally { socket.close(); }
});
