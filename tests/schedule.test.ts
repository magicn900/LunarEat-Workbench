import { beforeAll, afterAll, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/server/store.js';
import { Schedule } from '../src/server/schedule.js';
import { Lifecycle } from '../src/server/lifecycle.js';
import { emptyTask, type ScheduledTask, type TaskFields, descendants, dateWarnings } from '../src/shared/schedule.js';
import { capabilities } from '../src/shared/permissions.js';
import type { Actor } from '../src/shared/model.js';
import { createApp } from '../src/server/app.js';
import { Service } from '../src/server/service.js';
import { createCodec, type Codec } from '../src/server/codec.js';

    expect(() => schedule.save(actor, { requestId: randomUUID(), version: 0, task: { ...emptyTask, title: 'Invalid owners', ownerIds: null } })).toThrow();
it('shares one task between all owners without allowing assignment changes by updaters', () => {
    const task = create({ ownerIds: ['other', 'owner', 'other'] });
    expect(task.ownerIds).toEqual(['other', 'owner']);
    const saved = update(task, { status: 'doing' }, { ...actor, userId: 'other', scopes: ['schedule.read', 'schedule.update'] });
    expect(update(saved, { description: 'Shared' }, { ...actor, scopes: ['schedule.read', 'schedule.update'] }).description).toBe('Shared');
    expect(() => update(saved, { ownerIds: ['other'] }, { ...actor, userId: 'other', scopes: ['schedule.read', 'schedule.update'] })).toThrow();
    expect(() => create({ ownerIds: ['owner', 'foreign'] })).toThrow('可用成员');
    const preview = new Lifecycle(store).preview({ kind: 'member', id: 'other', projectId: 'one' }, actor.userId);
    expect(preview.counts.scheduledTasks).toBeGreaterThan(0);
});
it('reads legacy single-owner data without rewriting or losing it', () => {
    const task = create();
    const legacy = { ...fields(task), ownerId: 'owner' } as Record<string, unknown>;
    delete legacy.ownerIds;
    store.db.prepare('UPDATE schedule_tasks SET data=? WHERE id=?').run(JSON.stringify(legacy), task.id);
    const restored = schedule.tasks('one').find(candidate => candidate.id === task.id)!;
    expect(restored.ownerIds).toEqual(['owner']);
    expect(update(restored, { ownerIds: ['owner', 'other'] }).ownerIds).toEqual(['other', 'owner']);
});
let store: Store, schedule: Schedule, directory: string, codec: Codec, app: Awaited<ReturnType<typeof createApp>>;
const actor: Actor = { userId: 'owner', username: 'Owner', projectId: 'one', kind: 'human', sessionId: 'session', scopes: capabilities, canSync: true };
const fields = (task: TaskFields): TaskFields => { const { title, description, acceptance, parentId, ownerIds, startDate, endDate, status, blockedReason } = task; return { title, description, acceptance, parentId, ownerIds, startDate, endDate, status, blockedReason }; };
const create = (overrides: Partial<TaskFields> = {}) => schedule.save(actor, { requestId: randomUUID(), version: 0, task: { ...emptyTask, title: 'Task', ...overrides } });
const update = (task: ScheduledTask, overrides: Partial<TaskFields>, current = actor) => schedule.save(current, { requestId: randomUUID(), id: task.id, version: task.version, task: { ...fields(task), ...overrides } });
beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-schedule-')); store = new Store(directory); schedule = new Schedule(store);
    store.db.exec("INSERT INTO projects VALUES ('one','One'),('two','Two'); INSERT INTO users VALUES ('owner','Owner','unused'),('other','Other','unused'),('foreign','Foreign','unused'); INSERT INTO members VALUES ('owner','one',1),('other','one',0),('foreign','two',0);");
    store.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(store.hash('schedule-session'), 'owner', Date.now() + 600000);
    codec = await createCodec(); app = await createApp(new Service(store, codec));
});

it('member removal previews include tasks and detect changed assignments', () => {
    const task = create({ ownerIds: ['owner'] });
    const lifecycle = new Lifecycle(store), target = { kind: 'member' as const, id: 'owner', projectId: 'one' };
    const preview = lifecycle.preview(target, actor.userId);
    expect(preview.counts.scheduledTasks).toBeGreaterThan(0);
    update(task, { ownerIds: [] });
    expect(() => lifecycle.remove(target, { id: actor.userId, username: actor.username }, preview.name, preview.expected)).toThrow('关联内容已变化');
});
afterAll(async () => { await app.close(); await codec.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
it('stores arbitrary task nesting independently of design trees', () => {
    const parent = create({ title: 'Prototype' }), child = create({ parentId: parent.id }), leaf = create({ parentId: child.id, ownerIds: ['other'] });
    expect(descendants(schedule.tasks('one'), parent.id)).toEqual(new Set([child.id, leaf.id]));
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({ count: 0 });
    expect(schedule.tasks('two')).toEqual([]);
});
it('rejects cycles, unknown parents, invalid dates and foreign owners', () => {
    const parent = create(), child = create({ parentId: parent.id });
    expect(() => update(parent, { parentId: child.id })).toThrow('后代');
    expect(() => update(parent, { parentId: parent.id })).toThrow('自身');
    expect(() => create({ parentId: randomUUID() })).toThrow('父任务不存在');
    expect(() => create({ ownerIds: ['foreign'] })).toThrow('可用成员');
    expect(() => create({ startDate: '2026-02-30', endDate: '2026-03-02' })).toThrow();
    expect(() => create({ startDate: '2026-09-14' })).toThrow('同时设置');
    expect(() => create({ startDate: '2026-09-15', endDate: '2026-09-14' })).toThrow('结束日期');
    expect(() => create({ status: 'blocked', blockedReason: '  ' })).toThrow('阻塞原因');
});
it('requires manual parent acceptance and reopening ancestors first', () => {
    let parent = create(); let child = create({ parentId: parent.id });
    expect(() => update(parent, { status: 'done' })).toThrow('子任务');
    child = update(child, { status: 'done' });
    expect(schedule.tasks('one').find(task => task.id === parent.id)?.status).toBe('todo');
    parent = update(parent, { status: 'done' });
    expect(() => update(child, { status: 'doing' })).toThrow('重新开启');
    expect(() => create({ parentId: parent.id })).toThrow('重新开启');
    parent = update(parent, { status: 'doing' });
    expect(update(child, { status: 'doing' }).status).toBe('doing');
});
it('warns about ancestor dates without cascading edits', () => {
    const parent = create({ startDate: '2026-09-14', endDate: '2026-09-20' });
    const child = create({ parentId: parent.id, startDate: '2026-09-13', endDate: '2026-09-25' });
    expect(dateWarnings(schedule.tasks('one'), child).map(task => task.id)).toEqual([parent.id]);
    expect(schedule.tasks('one').find(task => task.id === parent.id)).toEqual(parent);
});
it('enforces assigned-only updates, read-only and project isolation', () => {
    const task = create({ ownerIds: ['other'] });
    const updater = { ...actor, userId: 'other', scopes: ['schedule.read', 'schedule.update'] };
    const saved = update(task, { status: 'doing', description: 'Working' }, updater);
    expect(saved.status).toBe('doing');
    for (const change of [{ ownerIds: ['owner'] }, { title: 'Renamed' }, { acceptance: 'Changed' }, { startDate: '2026-09-14', endDate: '2026-09-15' }]) expect(() => update(saved, change, updater)).toThrow('只能更新');
    expect(() => update(saved, { status: 'done' }, { ...updater, userId: 'owner' })).toThrow('只能更新');
    expect(() => update(saved, { status: 'done' }, { ...actor, scopes: ['schedule.read'] })).toThrow('缺少权限');
    expect(() => update(saved, {}, { ...actor, projectId: 'two' })).toThrow('任务不存在');
});
it('rejects stale changes and supports exact request retries', () => {
    const task = create(); const payload = { requestId: randomUUID(), id: task.id, version: task.version, task: { ...fields(task), title: 'Changed' } };
    const saved = schedule.save(actor, payload);
    expect(schedule.save(actor, payload)).toEqual(saved);
    expect(() => schedule.save(actor, { ...payload, task: { ...payload.task, title: 'Different' } })).toThrow('请求标识');
    expect(() => update(task, { title: 'Stale' })).toThrow('他人修改');
});
it('deletion never cascades and rejects stale versions', () => {
    const parent = create(), child = create({ parentId: parent.id });
    expect(() => schedule.remove(actor, { requestId: randomUUID(), id: parent.id, version: parent.version })).toThrow('级联删除');
    expect(() => schedule.remove(actor, { requestId: randomUUID(), id: child.id, version: child.version + 1 })).toThrow('他人修改');
    const payload = { requestId: randomUUID(), id: child.id, version: child.version };
    expect(schedule.remove(actor, payload)).toEqual({ ok: true });
    expect(schedule.remove(actor, payload)).toEqual({ ok: true });
});
it('retains former owners but does not permit assigning new tasks to them', () => {
    const task = create({ ownerIds: ['other'] });
    store.db.prepare('INSERT INTO account_access VALUES (?,0,1)').run('other');
    expect(schedule.members('one').find(member => member.id === 'other')?.active).toBe(false);
    expect(() => create({ ownerIds: ['other'] })).toThrow('可用成员');
    expect(update(task, { description: 'Preserved owner' }).ownerIds).toEqual(['other']);
});
it('exposes authenticated APIs, validates input and rejects cross-site writes', async () => {
    const headers = { cookie: 'session=schedule-session', 'x-project-id': 'one', 'x-workbench-client': 'test' };
    expect((await app.inject({ url: '/api/schedule' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/schedule', headers })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/schedule', headers: { ...headers, 'x-project-id': 'two' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/schedule/tasks', headers, payload: {} })).statusCode).toBe(400);
    const payload = { requestId: randomUUID(), version: 0, task: { ...emptyTask, title: 'API task' } };
    expect((await app.inject({ method: 'POST', url: '/api/schedule/tasks', headers: { ...headers, origin: 'https://evil.example' }, payload })).statusCode).toBe(403);
    const response = await app.inject({ method: 'POST', url: '/api/schedule/tasks', headers, payload });
    expect(response.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/schedule/tasks', headers, payload })).json()).toEqual(response.json());
});
it('archived projects are read-only and tasks survive database reopen', async () => {
    store.db.prepare('INSERT INTO project_lifecycle(project_id,archived,deleted,version) VALUES (?,1,0,1)').run('one');
    expect(() => create()).toThrow('归档');
    const before = schedule.tasks('one');
    const reopened = new Store(directory);
    expect(new Schedule(reopened).tasks('one')).toEqual(before); reopened.close();
    expect((await app.inject({ url: '/api/schedule', headers: { cookie: 'session=schedule-session', 'x-project-id': 'one' } })).json().scopes).toEqual(expect.arrayContaining(['schedule.read']));
});
