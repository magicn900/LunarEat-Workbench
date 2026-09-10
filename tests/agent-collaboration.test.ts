import { beforeAll, beforeEach, afterEach, afterAll, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Store } from '../src/server/store.js';
import { createCodec } from '../src/server/codec.js';
import { Service } from '../src/server/service.js';
import { createApp } from '../src/server/app.js';
import { seed } from '../src/server/seed.js';
import { actorFor, issueToken } from '../src/server/auth.js';
import { AgentCollaboration } from '../src/server/agentCollaboration.js';
import type { Actor, Tree } from '../src/shared/model.js';

let directory: string, store: Store, codec: Awaited<ReturnType<typeof createCodec>>, service: Service, app: Awaited<ReturnType<typeof createApp>>, human: Actor, agent: Actor, token: string, url: string, initialHead: string;
const taskId = 'integration-task';
const send = async (command: string, payload: unknown = {}, credential = token) => {
    const response = await app.inject({ method: 'POST', url: '/api/agent/' + command, headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
    return { status: response.statusCode, ...response.json() };
};
const tree = () => store.tree(service.workspace(human).head);
const write = (operations: unknown[], extra = {}) => send('edit', { taskId, requestId: randomUUID(), operations, ...extra });
beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-agent-collaboration-')); store = new Store(join(directory, 'data')); seed(store, 'isolated-agent-tests'); codec = await createCodec(); service = new Service(store, codec); app = await createApp(service); url = await app.listen({ port: 0, host: '127.0.0.1' });
    const user = store.db.prepare("SELECT id FROM users WHERE username='designer'").get() as { id: string };
    store.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(store.hash('human-agent'), user.id, Date.now() + 3600000); human = actorFor(store, 'human-agent', false, 'demo'); initialHead = service.workspace(human).head;
}, 30000);
it('显式 fields 直接投影，元信息修改不用回传正文', async () => {
    const found = await send('read', { ids: ['frost'], fields: ['title','cost'] }); expect(found.items[0].fields.cost).toBe(2); expect(found.items[0].title).toBe('霜刃'); expect(found.items[0].absent).toBeUndefined();
    const before = tree().frost;
    const edited = await write([{ type: 'metadata', id: 'frost', title: '新霜刃' }], { snapshot: found.snapshot }); expect(edited.status).toBe(200); expect((tree().frost as any).body).toBe((before as any).body); expect((tree().frost as any).title).toBe('新霜刃');
});
it('保存回执给出整批字段值与数量，不需逐行验证', async () => {
    const result = await send('query', { definition: { collection: 'skills', filters: [{ key: 'cost', operator: 'equals', value: 1 }] }, selection: true });
    const applied = await write([{ type: 'bulk-field', selection: result.selection, key: 'cost', value: 4 }]); expect(applied.checks.fields).toEqual([{ key: 'cost', value: 4, absent: false, count: 2 }]); expect(applied.checks.bodyChangedCount).toBe(0); expect(applied.checks.fieldsComplete).toBe(true);
});
it('发布固定版本、读取与丢弃实际闭环', async () => {
    await write([{ type: 'field', id: 'frost', key: 'cost', expected: 2, value: 7 }]);
    const review = await send('versions', { action: 'review' });
    const published = await send('versions', { action: 'publish', taskId, requestId: randomUUID(), review: review.review, title: 'isolated publication', description: '' }); expect(published.status).toBe(200);
    const inspected = await send('versions', { action: 'inspect', id: published.id }); expect(inspected.revision).toBe(published.revision);
    expect((await send('versions', { action: 'confirmations', id: published.id })).items).toEqual([]);
    await write([{ type: 'field', id: 'frost', key: 'cost', expected: 7, value: 8 }]);
    const fixed = await send('read', { revision: published.revision, ids: ['frost'], fields: ['cost'] }); expect(fixed.items[0].fields.cost).toBe(7);
    const draftReview = await send('versions', { action: 'review' });
    const preview = await send('versions', { action: 'discard-preview', review: draftReview.review, targets: [{ id: 'frost' }] }); expect(preview.targetCount).toBe(1); expect(preview.complete).toBe(true);
    const discarded = await send('versions', { action: 'discard', plan: preview.plan, taskId, requestId: randomUUID() }); expect(discarded.status).toBe(200); expect((tree().frost as any).fields.cost).toBe(7);
});
it('Agent 可发现并撤回本人发布，重试幂等，文案恢复且可重新发布', async () => {
    expect((await write([{ type: 'field', id: 'frost', key: 'cost', expected: 2, value: 17 }])).status).toBe(200);
    const review = await send('versions', { action: 'review' });
    const published = await send('versions', { action: 'publish', taskId, requestId: randomUUID(), review: review.review, title: 'withdraw test', description: 'preserved description' });
    expect(published.status).toBe(200);
    expect((await send('versions', {action:'inspect',id:published.id})).withdrawalBlocker).toBeNull();
    const input={action:'withdraw',id:published.id,revision:published.revision,taskId,requestId:randomUUID()};
    expect((await send('versions',input)).status).toBe(200);
    expect((await send('versions',input)).replayed).toBe(true);
    expect((await send('versions',{action:'inspect',id:published.id})).status).toBe(404);
    const restored=await send('versions',{action:'review'});
    expect(restored.publicationDraft).toEqual({title:'withdraw test',description:'preserved description'});
    expect(restored.main).toBe(published.old_main);
    const republished=await send('versions',{action:'publish',taskId,requestId:randomUUID(),review:restored.review,...restored.publicationDraft});
    expect(republished.status).toBe(200);
    expect((await send('versions',{action:'review'})).publicationDraft).toBeUndefined();
});
beforeEach(() => {
    store.db.prepare('UPDATE workspaces SET head=? WHERE id=?').run(initialHead, service.workspace(human).id);
    token = issueToken(store, human, 'isolated test', ['workspace.read','workspace.write','design.publish','inspiration.read','inspiration.write']).token; agent = actorFor(store, token, true, 'demo');
});
afterEach(() => {
    const state = service.control.publicState(service.workspace(human).id);
    if (state) service.control.action(human, service.workspace(human).id, { action: 'revoke', writeSessionId: state.id });
});
afterAll(async () => { await app.close(); await codec.close(); store.close(); const target = resolve(directory); if (target.startsWith(resolve(tmpdir()) + sep) && target.includes('workbench-agent-collaboration-')) rmSync(target, { recursive: true, force: true }); });

it('连接与精确查找仅返回所需字段，不读取正文或灵感', async () => {
    const connected = await send('connect'); expect(connected.commands).toContain('edit'); expect(connected.tree).toBeUndefined();
    const found = await send('find', { query: '霜刃', fields: ['cost'] }); expect(found.items).toHaveLength(1); expect(found.items[0].fields.cost).toBe(2); expect(found.items[0].body).toBeUndefined(); expect(JSON.stringify(found).length).toBeLessThan(2000);
    expect((await send('find', { query: '霜' })).totalCount).toBe(0);
    expect((await send('find', { query: '霜', match: 'contains' })).totalCount).toBe(1);
    expect((await send('find', { query: '琥珀纸鹤', mode: 'text', match: 'contains' })).totalCount).toBe(0);
    expect((await send('inspiration', { action: 'find', query: '琥珀纸鹤' })).totalCount).toBe(1);
});
it('按操作发现严格契约，拒绝错误分页位置和被忽略的参数', async () => {
    expect((await send('schema', { name: 'edit.field' })).input.properties.type.const).toBe('field');
    expect((await send('schema', { name: 'toString' })).status).toBe(404);
    expect((await send('history', { query: '霜刃' })).code).toBe('INVALID_INPUT');
    const view = { ...tree()['skills-table'], pageSize: 10 };
    expect((await write([{ type: 'put', entity: view }])).code).toBe('INVALID_INPUT');
    expect((await send('read', { ids: ['frost'], offset: 1 })).code).toBe('INVALID_INPUT');
});
it('正文增长不放大定位结果，范围读取固定快照并可完整续读', async () => {
    const expanded = tree(); const object = expanded.frost; if (object.kind !== 'object') throw new Error(); object.body = '# 巨大正文\n\n' + '正文数据'.repeat(100000); store.db.prepare('UPDATE workspaces SET head=? WHERE id=?').run(store.putTree(expanded), service.workspace(human).id);
    const found = await send('find', { query: '霜刃', fields: ['cost'] }); expect(JSON.stringify(found).length).toBeLessThan(2000);
    const body = await send('read', { ids: ['frost'], field: 'body', length: 100 }); expect(body.complete).toBe(false); expect(body.next.offset).toBe(100);
    const old = await send('read', body.next); expect(old.snapshot).toBe(body.snapshot); expect(old.offset).toBe(100);
    expect((await send('read', { ids: ['frost'], field: 'body', offset: 9999999 })).code).toBe('RANGE_INVALID');
});
it('查询支持类型筛选、投影和稳定分页，游标不可跨凭据或用途', async () => {
    const result = await send('query', { definition: { collection: 'skills', filters: [{ key: 'cost', operator: 'gte', value: 1 }] }, fields: ['cost'], limit: 1, selection: true }); expect(result.matchedCount).toBe(3); expect(result.complete).toBe(false);
    const next = await send('query', { cursor: result.next }); expect(next.snapshot).toBe(result.snapshot); expect(next.items).toHaveLength(2);
    expect((await send('find', { cursor: result.next })).code).toBe('CONTEXT_EXPIRED');
    const other = issueToken(store, human, 'other credential', ['workspace.read']).token; expect((await send('query', { cursor: result.next }, other)).code).toBe('CONTEXT_EXPIRED');
    expect((await send('query', { cursor: result.next, fields: ['cost'] })).code).toBe('INVALID_INPUT');
});
it('原子创建真实数值筛选和分页视图并嵌入，返回实际查询结果', async () => {
    const result = await write([{ type: 'put', alias: 'newview', entity: { id: 'filtered-view', kind: 'view', path: '视图/filtered.json', title: '高消耗', collection: 'skills', layout: 'table', columns: ['title','cost'], filters: [{ key: 'cost', operator: 'gte', value: 2 }], pagination: { pageSize: 10 } } }, { type: 'embed', id: 'overview', target: '$newview', after: '## 技能速览' }]);
    expect(result.status).toBe(200); expect(result.changedCount).toBe(2); expect(result.checks.persisted).toBe(true); expect(result.checks.views[0]).toMatchObject({ pageSize: 10, matchedCount: 1 }); expect((tree().overview as any).body).toContain(':::view[filtered-view]');
});
it('失败的复合修改不会留下半个视图或部分字段修改', async () => {
    const before = service.workspace(human).head;
    const result = await write([{ type: 'field', id: 'frost', key: 'cost', expected: 2, value: 3 }, { type: 'patch', id: 'overview', before: '不存在的锚点', after: '不能部分成功' }]); expect(result.status).toBe(409); expect(service.workspace(human).head).toBe(before);
});
it('冻结批量选择一次修改全部命中行，拒绝悄悄扩大选择', async () => {
    const result = await send('query', { definition: { collection: 'skills', filters: [{ key: 'cost', operator: 'equals', value: 1 }] }, selection: true, fields: ['cost'] });
    const applied = await write([{ type: 'bulk-field', selection: result.selection, key: 'cost', value: 4 }]); expect(applied.changedCount).toBe(2); expect((tree().frost as any).fields.cost).toBe(2);
    const rejected = await write([{ type: 'bulk-field', selection: result.selection, key: 'cost', value: 5 }]); expect(rejected.code).toBe('SELECTION_CHANGED');
});
it('已有快照的字段前提和章节前提保护后来的修改', async () => {
    const source = await send('find', { query: '霜刃', fields: ['cost'] });
    expect((await write([{ type: 'field', id: 'frost', key: 'cost', value: 3 }], { snapshot: source.snapshot })).status).toBe(200);
    expect((await write([{ type: 'field', id: 'frost', key: 'cost', value: 4 }], { snapshot: source.snapshot })).status).toBe(409);
    const outline = await send('read', { ids: ['overview'], facets: ['outline'] });
    await write([{ type: 'patch', id: 'overview', before: '每一次选择', after: '每一回选择' }]);
    expect((await write([{ type: 'section', section: outline.items[0].outline[0].section, text: '# 替代\n' }])).code).toBe('SECTION_CHANGED');
});
it('删除必须预览，预览不获取控制权，应用可以安全撤销', async () => {
    const source = await send('find', { query: '霜刃' });
    const operations = [{ type: 'delete', id: 'frost' }];
    const preview = await send('edit', { mode: 'preview', snapshot: source.snapshot, operations }); expect(preview.requiresConfirmation).toBe(true); expect(preview.checks.persisted).toBe(false); expect(service.control.publicState(service.workspace(human).id)).toBeNull();
    const applied = await send('edit', { taskId, requestId: randomUUID(), plan: preview.plan }); expect(applied.status).toBe(200); expect(tree().frost).toBeUndefined();
    const restored = await send('history', { action: 'undo', id: 'agent:' + applied.writeSessionId, taskId, writeSessionId: applied.writeSessionId, requestId: randomUUID() }); expect(restored.status).toBe(200); expect(tree().frost).toBeDefined();
});
it('同一请求安全重放，不同输入不能复用请求号，撤回后不能重获控制权', async () => {
    const input = { taskId, requestId: randomUUID(), operations: [{ type: 'field', id: 'frost', key: 'cost', expected: 2, value: 3 }] };
    const first = await send('edit', input); expect(first.status).toBe(200);
    service.control.action(human, service.workspace(human).id, { action: 'revoke', writeSessionId: first.writeSessionId });
    const again = await send('edit', input); expect(again.replayed).toBe(true); expect(again.writeSessionId).toBe(first.writeSessionId); expect(service.control.publicState(service.workspace(human).id)).toBeNull();
    expect((await send('edit', { ...input, operations: [{ ...input.operations[0], value: 4 }] })).code).toBe('REQUEST_ID_REUSED');
    expect((await send('edit', { ...input, requestId: randomUUID() })).code).toBe('WRITE_SESSION_REVOKED');
});
it('过期和已释放会话可以幂等释放，撤回和其他任务不可冒用', async () => {
    const result = await write([{ type: 'field', id: 'frost', key: 'cost', expected: 2, value: 3 }]); store.db.prepare('UPDATE write_sessions SET expires=0 WHERE id=?').run(result.writeSessionId);
    const input = { action: 'release', taskId, writeSessionId: result.writeSessionId };
    expect((await send('control', input)).previousStatus).toBe('expired'); expect((await send('control', input)).status).toBe(200);
    expect((await send('control', { ...input, taskId: 'another-task' })).code).toBe('WRITE_SESSION_INVALID');
});
it('权限在分页和回执读取时重新校验，灵感范围读取要求版本一致', async () => {
    const noNotes = issueToken(store, human, 'workspace only', ['workspace.read']).token;
    expect((await send('inspiration', { action: 'find' }, noNotes)).status).toBe(403);
    const note = await send('inspiration', { action: 'read', id: 'idea-1', length: 4 }); expect(note.complete).toBe(false);
    expect((await send('inspiration', { action: 'read', id: 'idea-1', offset: 4 })).code).toBe('VERSION_REQUIRED');
    expect((await send('inspiration', { action: 'read', id: 'idea-1', offset: 4, version: 999 })).code).toBe('NOTE_CHANGED');
    const collaboration = new AgentCollaboration(service);
    expect(() => collaboration.run({ ...agent, scopes: [] }, 'read', { receipt: randomUUID() })).toThrow();
});
it('历史和版本摘要有固定来源，不包含全工作区', async () => {
    await write([{ type: 'field', id: 'frost', key: 'cost', expected: 2, value: 8 }]);
    const history = await send('history', { actor: 'agent', objectId: 'frost', limit: 1 }); expect(history.items).toHaveLength(1);
    const inspect = await send('history', { action: 'inspect', id: history.items[0].id }); expect(inspect.before).toBeTruthy(); expect(inspect.after).toBeTruthy();
    const review = await send('versions', { action: 'review' }); expect(review.sources.draft).toBeTruthy(); expect(review.ours).toBeUndefined(); expect(review.items.some((item: any) => item.id === 'frost')).toBe(true);
});
it('下载客户端支持离线精确帮助、全局参数、内联输入和自动幂等号', async () => {
    const kit = join(directory, 'kit'); const manifest = (await app.inject('/api/agent/kit/manifest.json')).json();
    for (const file of manifest.files) { const destination = join(kit, file.path); mkdirSync(join(destination, '..'), { recursive: true }); writeFileSync(destination, (await app.inject('/api/agent/kit/' + file.path)).body); }
    const execute = promisify(execFile), script = join(kit, 'scripts/agent.mjs');
    const invoke = async (args: string[], environment = {}) => { try { return JSON.parse((await execute(process.execPath, [script, ...args], { env: { ...process.env, WORKBENCH_CONFIG_HOME: join(directory, 'client-config'), WORKBENCH_TOKEN: token, ...environment } })).stdout); } catch (error: any) { return JSON.parse(error.stdout); } };
    expect((await invoke(['help','edit.field'])).input.properties.type.const).toBe('field');
    expect((await invoke(['--profile','trial','configure','--url',url])).configured).toBe(true);
    const invalid = await invoke(['read','--profile','trial','--json',JSON.stringify({ id: 'frost', part: 'schema' })]); expect(invalid.code).toBe('INVALID_INPUT'); expect(invalid.error).toContain('Expected top-level keys'); expect(invalid.status).toBeUndefined();
    if (process.platform === 'win32') {
        const command = "$OutputEncoding = [System.Text.UTF8Encoding]::new($false); '" + JSON.stringify({ query: '霜刃' }) + "' | & '" + process.execPath + "' '" + script + "' find --profile trial --input -";
        const result = await execute('powershell.exe', ['-NoProfile','-Command',command], { env: { ...process.env, WORKBENCH_CONFIG_HOME: join(directory, 'client-config'), WORKBENCH_TOKEN: token } }); expect(JSON.parse(result.stdout).items[0].id).toBe('frost');
    }
    const cliTask = (await invoke(['--profile','trial','new-task'])).taskId;
    const result = await invoke(['edit','--profile','trial','--task',cliTask,'--json',JSON.stringify({ operations: [{ type: 'field', id: 'frost', key: 'cost', expected: 2, value: 9 }] })]); expect(result.ok).toBe(true); expect(result.requestId).toBeTruthy(); expect(result.checks.persisted).toBe(true);
    expect((await invoke(['release','--profile','trial','--task',cliTask])).ok).toBe(true);
    const retryTask = (await invoke(['--profile','trial','new-task'])).taskId;
    const hook = join(directory, 'drop-response.mjs'), marker = join(directory, 'dropped');
    writeFileSync(hook, 'import {existsSync,writeFileSync} from "node:fs"; const original=globalThis.fetch; globalThis.fetch=async(...args)=>{ const response=await original(...args); if(String(args[0]).endsWith("/edit") && response.ok && !existsSync(' + JSON.stringify(marker) + ')){writeFileSync(' + JSON.stringify(marker) + ',"done"); await response.text(); throw Error("simulated response loss");} return response; };');
    const retryArgs = ['edit','--profile','trial','--task',retryTask,'--json',JSON.stringify({ operations: [{ type: 'field', id: 'frost', key: 'cost', expected: 9, value: 10 }] })];
    expect((await invoke(retryArgs, { NODE_OPTIONS: '--import=' + pathToFileURL(hook).href })).code).toBe('REQUEST_UNCERTAIN');
    const replay = await invoke(retryArgs); expect(replay.replayed).toBe(true); expect(replay.writeSessionId).toBeTruthy();
    expect((await invoke(['release','--profile','trial','--task',retryTask])).ok).toBe(true); expect(service.control.publicState(service.workspace(human).id)).toBeNull();
    expect(readFileSync(join(directory,'client-config','trial.json'),'utf8')).not.toContain(token);
}, 30000);
