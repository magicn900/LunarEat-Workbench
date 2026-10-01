import { beforeAll, afterAll, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Store } from '../src/server/store';
import { createCodec, type Codec } from '../src/server/codec';
import { Service } from '../src/server/service';
import { createApp } from '../src/server/app';
import { seed } from '../src/server/seed';
import { actorFor } from '../src/server/auth';
import { renderPdf } from '../src/server/pdfRenderer';
import { pdfOptionsSchema } from '../src/shared/pdfExport';

let directory: string, store: Store, codec: Codec, service: Service, app: Awaited<ReturnType<typeof createApp>>, cookie: string, otherCookie: string;
const headers = () => ({ cookie, 'x-workbench-client': 'test' });
const actor = () => actorFor(store, cookie.replace('session=', ''), false);
const head = () => service.workspace(actor()).head as string;
const endpoint = '/api/projects/demo/documents/overview/export-pdf';
beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-pdf-')); store = new Store(directory); seed(store, 'pdf-password-123'); codec = await createCodec(); service = new Service(store, codec); app = await createApp(service);
    for (const username of ['designer', 'developer']) {
        const response = await app.inject({ method: 'POST', url: '/api/login', headers: { 'x-workbench-client': 'test' }, payload: { username, password: 'pdf-password-123' } });
        const session = response.headers['set-cookie']!.toString().split(';')[0];
        if (username === 'designer') cookie = session; else otherCookie = session;
    }
});
afterAll(async () => {
    await app?.close(); await codec?.close(); store?.close();
    if (directory) { const target = resolve(directory); if (dirname(target) === resolve(tmpdir()) && basename(target).startsWith('workbench-pdf-')) rmSync(target, { recursive: true, force: true }); }
});
it('拒绝匿名和跨项目请求，校验输入与快照，不要求写入权限', async () => {
    expect((await app.inject({ method: 'POST', url: endpoint + '/inspect', headers: { 'x-workbench-client': 'test' }, payload: { head: head() } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: endpoint.replace('/demo/', '/other/') + '/inspect', headers: headers(), payload: { head: head() } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: endpoint + '/inspect', headers: headers(), payload: { head: 'stale' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: endpoint + '/inspect', headers: headers(), payload: { head: head(), timeZone: 'not/a/timezone' } })).statusCode).toBe(400);
    const token = (await app.inject({ method: 'POST', url: '/api/tokens', headers: headers(), payload: { name: 'pdf-reader', scopes: ['workspace.read'] } })).json().token;
    const response = await app.inject({ method: 'POST', url: endpoint + '/inspect', headers: { authorization: 'Bearer ' + token }, payload: { head: head() } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().views[0]).toMatchObject({ rows: 3, title: '技能速览' });
});
it('生成真实 PDF，返回私有响应，不改变草稿或发布版本', async () => {
    const beforeHead = head(), beforeMain = store.main('demo');
    const response = await app.inject({ method: 'POST', url: endpoint, headers: headers(), payload: { head: beforeHead, options: { toc: true, orientation: 'landscape' } } });
    expect(response.statusCode, response.body.slice(0, 100)).toBe(200);
    expect(response.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(response.headers['content-type']).toContain('application/pdf');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(head()).toBe(beforeHead); expect(store.main('demo')).toBe(beforeMain);
});
it('附件只按本人权限读取，不抓取外网，未确认不能静默丢图', async () => {
    const bytes = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#376548' } }).png().toBuffer();
    const upload = await app.inject({ method: 'POST', url: '/api/projects/demo/documents/overview/images', headers: { cookie: otherCookie, 'x-workbench-client': 'test', 'content-type': 'application/octet-stream' }, payload: bytes });
    expect(upload.statusCode).toBe(200);
    const document = store.entity(head(), 'overview');
    if (document?.kind !== 'object') throw Error('fixture');
    service.execute(actor(), {}, () => service.mutate(actor(), randomUUID(), [{ type: 'put', expected: document, entity: { ...document, body: `![他人草稿](${upload.json().url})\n\n![外网](http://127.0.0.1:1/private)` } }]));
    const inspection = await app.inject({ method: 'POST', url: endpoint + '/inspect', headers: headers(), payload: { head: head() } });
    expect(inspection.statusCode, inspection.body).toBe(200);
    expect(inspection.json().warnings).toHaveLength(2);
    const blocked = await app.inject({ method: 'POST', url: endpoint, headers: headers(), payload: { head: head() } });
    expect(blocked.statusCode).toBe(422);
    const acknowledged = await app.inject({ method: 'POST', url: endpoint, headers: headers(), payload: { head: head(), options: { allowIncomplete: true } } });
    expect(acknowledged.statusCode, acknowledged.body.slice(0, 100)).toBe(200);
    expect(acknowledged.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
});
it('中止生成会关闭浏览器，不阻塞后续生成', async () => {
    const controller = new AbortController();
    const pending = renderPdf('<html><body>Cancelled PDF</body></html>', pdfOptionsSchema.parse({}), 'draft', controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow();
    const bytes = await renderPdf('<html><body>Recovered PDF</body></html>', pdfOptionsSchema.parse({}), 'draft', AbortSignal.timeout(15000));
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
});
