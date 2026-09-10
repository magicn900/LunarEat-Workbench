import { beforeAll, afterAll, afterEach, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/server/store';
import { createCodec, type Codec } from '../src/server/codec';
import { Service } from '../src/server/service';
import { createApp } from '../src/server/app';
import { seed } from '../src/server/seed';
import { actorFor } from '../src/server/auth';

let directory: string, store: Store, codec: Codec, service: Service, app: Awaited<ReturnType<typeof createApp>>, cookie: string;
const actor = () => actorFor(store, cookie.slice('session='.length));
const headers = () => ({ cookie, 'x-workbench-client': 'test' });
const source = () => service.documentSource(actor(), 'overview').body;
const save = (body: string, expected = source(), requestId = randomUUID()) => app.inject({ method: 'POST', url: '/api/documents/overview/source', headers: headers(), payload: { body, expected, requestId } });
beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-recovery-'));
    store = new Store(directory); seed(store, 'recovery-password-123');
    codec = await createCodec(); service = new Service(store, codec); app = await createApp(service);
    const response = await app.inject({ method: 'POST', url: '/api/login', headers: { 'x-workbench-client': 'test' }, payload: { username: 'designer', password: 'recovery-password-123' } });
    cookie = response.headers['set-cookie']!.toString().split(';')[0];
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await app?.close(); await codec?.close(); store?.close(); if (directory?.startsWith(join(tmpdir(), 'workbench-recovery-'))) rmSync(directory, { recursive: true, force: true }); });

it('已有空标题图片缓存可重建，版本递增且旧客户端不能误用旧 steps', async () => {
    expect((await save('![](data:image/png;base64,AAAA)')).statusCode).toBe(200);
    const initial = service.document(actor(), 'overview');
    const broken = structuredClone(initial.doc);
    const walk = (node: any) => { if (node.type === 'image') node.attrs.title = null; for (const child of node.content || []) walk(child); };
    walk(broken);
    store.db.prepare('UPDATE documents SET doc=? WHERE workspace_id=? AND entity_id=?').run(JSON.stringify(broken), service.workspace(actor()).id, 'overview');
    const recovered = service.document(actor(), 'overview', initial.version);
    expect(recovered.version).toBeGreaterThan(initial.version);
    expect(recovered.steps).toEqual([]);
    expect(() => codec.schema.nodeFromJSON(recovered.doc)).not.toThrow();
    expect((await save('正文')).statusCode).toBe(200);
    expect(source()).toBe('正文');
});

it('解析失败仍保存源码，沿用存储末尾空白规范并返回实际值，撤销不依赖渲染', async () => {
    const original = source();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const parse = vi.spyOn(codec, 'parse').mockImplementation(() => { throw new RangeError('Expected value of type string for attribute title on type image, got null'); });
    const text = '  无法渲染的正文' + String.fromCharCode(10, 10);
    const response = await save(text);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().warning.code).toBe('DOCUMENT_RENDER_FAILED');
    expect(source()).toBe(text.trimEnd());
    expect(response.json().body).toBe(source());
    const read = await app.inject({ url: '/api/documents/overview', headers: headers() });
    expect(read.statusCode).toBe(422);
    expect(read.json()).toMatchObject({ code: 'DOCUMENT_RENDER_FAILED', requiredAction: 'edit_markdown' });
    expect(read.json().error).toContain('title');
    expect(read.json().requestId).toBeTruthy();
    expect((await app.inject({ url: '/api/documents/overview/source', headers: headers() })).json().body).toBe(source());
    service.historyStep(actor(), { requestId: randomUUID(), direction: 'undo', scope: 'overview' });
    expect(source()).toBe(original);
    parse.mockRestore();
});

it('源码保存保留并发修改且相同 requestId 只保存一次', async () => {
    const expected = source(), requestId = randomUUID();
    const first = await save('新的源码', expected, requestId);
    expect(first.statusCode).toBe(200);
    expect((await save('新的源码', expected, requestId)).json()).toEqual(first.json());
    expect((await save('旧页面覆盖', expected)).statusCode).toBe(409);
    expect(source()).toBe('新的源码');
});

it('源码入口仍检查权限、控制权与页面存在性', async () => {
    expect((await app.inject({ url: '/api/documents/overview/source' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/documents/missing/source', headers: headers() })).statusCode).toBe(404);
    expect(() => service.saveDocumentSource({ ...actor(), scopes: ['workspace.read'] }, 'overview', { requestId: randomUUID(), expected: source(), body: '' })).toThrow();
    vi.spyOn(service.control, 'prepare').mockImplementation(() => { throw Object.assign(new Error('locked'), { status: 423 }); });
    expect((await save('不能写入')).statusCode).toBe(423);
});

it('旧编辑器缓存重新解析高亮，拒绝旧协议写入', async () => {
    await save('==需要高亮==');
    const initial = service.document(actor(), 'overview');
    const oldDoc = codec.schema.node('doc', null, [codec.schema.node('paragraph', null, [codec.schema.text('==需要高亮==')])]);
    store.db.prepare('UPDATE documents SET doc=?,schema_version=2 WHERE workspace_id=? AND entity_id=?').run(JSON.stringify(oldDoc.toJSON()), service.workspace(actor()).id, 'overview');
    const updated = service.document(actor(), 'overview', initial.version);
    expect(updated.version).toBeGreaterThan(initial.version);
    expect(JSON.stringify(updated.doc)).toContain('highlight');
    const oldRequest = await app.inject({ method: 'POST', url: '/api/documents/overview/steps', headers: headers(), payload: { requestId: randomUUID(), version: updated.version, steps: [{}], clientId: 'old', groupId: 'old' } });
    expect(oldRequest.statusCode).toBe(409);
    expect(oldRequest.json().code).toBe('DOCUMENT_SCHEMA_CHANGED');
});

it('公式升级重建旧缓存而不修改正文，拒绝高亮版本的旧写入', async () => {
    await save('概率 $P(w)$');
    const initial = service.document(actor(), 'overview');
    const oldDoc = codec.schema.node('doc', null, [codec.schema.node('paragraph', null, [codec.schema.text('概率 $P(w)$')])]);
    store.db.prepare('UPDATE documents SET doc=?,schema_version=3 WHERE workspace_id=? AND entity_id=?').run(JSON.stringify(oldDoc.toJSON()), service.workspace(actor()).id, 'overview');
    const updated = service.document(actor(), 'overview', initial.version);
    expect(updated.schemaVersion).toBe(4); expect(updated.version).toBeGreaterThan(initial.version);
    expect(JSON.stringify(updated.doc)).toContain('math_inline'); expect(source()).toBe('概率 $P(w)$');
    const denied = await app.inject({ method: 'POST', url: '/api/documents/overview/steps', headers: headers(), payload: { requestId: randomUUID(), schemaVersion: 3, version: updated.version, steps: [{}], clientId: 'old', groupId: 'old' } });
    expect(denied.statusCode).toBe(409); expect(denied.json().code).toBe('DOCUMENT_SCHEMA_CHANGED');
});

it('未知后端异常只返回请求编号，不泄漏路径和敏感内容', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(service, 'documentSource').mockImplementation(() => { throw new Error('/private/secrets/token=hidden'); });
    const response = await app.inject({ url: '/api/documents/overview/source', headers: headers() });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: 'INTERNAL_ERROR', requestId: expect.any(String) });
    expect(response.body).not.toContain('hidden');
});
