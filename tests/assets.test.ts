import { beforeAll, afterAll, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { unzipSync, strFromU8 } from 'fflate';
import { Store } from '../src/server/store';
import { createCodec, type Codec } from '../src/server/codec';
import { Service } from '../src/server/service';
import { createApp } from '../src/server/app';
import { seed } from '../src/server/seed';
import { actorFor } from '../src/server/auth';
import { initializeProject } from '../src/server/projectState';
import { imageUploadLimit } from '../src/shared/assets';

let directory: string, store: Store, codec: Codec, service: Service, app: Awaited<ReturnType<typeof createApp>>, cookie: string, otherCookie: string;
const headers = (session = cookie) => ({ cookie: session, 'x-workbench-client': 'test', 'content-type': 'application/octet-stream' });
const image = (format: 'png' | 'jpeg' | 'webp' = 'png', color = '#4179aa') => sharp({ create: { width: 32, height: 20, channels: 3, background: color } }).toFormat(format).toBuffer();
const upload = (payload: Buffer, session = cookie) => app.inject({ method: 'POST', url: '/api/projects/demo/documents/overview/images', headers: headers(session), payload });
const actor = (session = cookie) => actorFor(store, session.slice('session='.length), false, 'demo');
beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-assets-')); store = new Store(directory); seed(store, 'assets-password-123'); codec = await createCodec(); service = new Service(store, codec); app = await createApp(service);
    for (const username of ['designer', 'developer']) {
        const response = await app.inject({ method: 'POST', url: '/api/login', headers: { 'x-workbench-client': 'test' }, payload: { username, password: 'assets-password-123' } });
        const session = response.headers['set-cookie']!.toString().split(';')[0];
        if (username === 'designer') cookie = session; else otherCookie = session;
    }
});
afterAll(async () => { await app?.close(); await codec?.close(); store?.close(); if (directory?.startsWith(join(tmpdir(), 'workbench-assets-'))) rmSync(directory, { recursive: true, force: true }); });
it('PNG、JPEG、WebP 完整校验并保留原始字节，文件名不参与路径', async () => {
    for (const format of ['png', 'jpeg', 'webp'] as const) {
        const bytes = await image(format);
        const response = await app.inject({ method: 'POST', url: '/api/projects/demo/documents/overview/images', headers: { ...headers(), 'x-file-name': encodeURIComponent('../../outside.' + format) }, payload: bytes });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toMatchObject({ width: 32, height: 20, mime: 'image/' + format });
        const read = await app.inject({ url: response.json().url, headers: { cookie } });
        expect(read.statusCode).toBe(200); expect(read.rawPayload).toEqual(bytes); expect(read.headers['x-content-type-options']).toBe('nosniff');
    }
    expect(existsSync(join(directory, 'outside.png'))).toBe(false);
});
it('拒绝匿名、只读、跨项目访问及伪造图片和超限文件', async () => {
    const bytes = await image();
    expect((await app.inject({ method: 'POST', url: '/api/projects/demo/documents/overview/images', headers: { 'x-workbench-client': 'test', 'content-type': 'application/octet-stream' }, payload: bytes })).statusCode).toBe(401);
    expect((await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>'))).statusCode).toBe(400);
    expect((await upload(Buffer.from('not an image'))).statusCode).toBe(400);
    expect((await upload(bytes.subarray(0, 40))).statusCode).toBe(400);
    expect((await upload(Buffer.alloc(imageUploadLimit + 1))).statusCode).toBe(413);
    const token = (await app.inject({ method: 'POST', url: '/api/tokens', headers: { cookie, 'x-workbench-client': 'test' }, payload: { name: 'image-reader', scopes: ['workspace.read'] } })).json().token;
    expect((await app.inject({ method: 'POST', url: '/api/projects/demo/documents/overview/images', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/octet-stream' }, payload: bytes })).statusCode).toBe(403);
    initializeProject(store, 'asset-other', '另一个项目');
    expect((await app.inject({ url: '/api/projects/asset-other/assets/' + randomUUID(), headers: { authorization: 'Bearer ' + token } })).statusCode).toBe(404);
});
it('图片按上传者保密；同项目去重不向其他草稿授予读取权限', async () => {
    const bytes = await image('png', '#80a120');
    const first = (await upload(bytes)).json();
    const repeated = (await upload(bytes)).json();
    expect(repeated.id).toBe(first.id);
    expect((await app.inject({ url: first.url, headers: { cookie: otherCookie } })).statusCode).toBe(404);
    const other = (await upload(bytes, otherCookie)).json();
    expect(other.id).not.toBe(first.id);
    const hashes = store.db.prepare('SELECT hash FROM image_assets WHERE id IN (?,?)').all(first.id, other.id) as { hash: string }[];
    expect(hashes[0].hash).toBe(hashes[1].hash);
    expect((await app.inject({ url: first.url, headers: { cookie: otherCookie } })).statusCode).toBe(404);
});
it('猜测图片地址不能通过自己发布引用来提升权限；合法发布后团队可读', async () => {
    const asset = (await upload(await image('png', '#a72070'))).json();
    const other = actor(otherCookie), owner = actor();
    const entity = { id: 'private-image-reference', kind: 'object' as const, path: '设计/private-image.md', title: '图片权限', collection: null, fields: {}, body: '![私有图片](' + asset.url + ')' };
    service.execute(other, {}, () => service.mutate(other, randomUUID(), [{ type: 'put', expected: null, entity }]));
    const denied = service.preview(other);
    expect(() => service.execute(other, {}, () => service.publish(other, { requestId: randomUUID(), head: denied.head, main: denied.main, title: '不能窃取图片', description: '' }))).toThrow('图片不存在或无权访问');
    expect((await app.inject({ url: asset.url, headers: { cookie: otherCookie } })).statusCode).toBe(404);
    service.execute(owner, {}, () => service.mutate(owner, randomUUID(), [{ type: 'put', expected: null, entity }]));
    const preview = service.preview(owner);
    service.execute(owner, {}, () => service.publish(owner, { requestId: randomUUID(), head: preview.head, main: preview.main, title: '分享图片', description: '' }));
    expect((await app.inject({ url: asset.url, headers: { cookie: otherCookie } })).statusCode).toBe(200);
    service.execute(owner, {}, () => service.mutate(owner, randomUUID(), [{ type: 'delete', id: entity.id, expected: entity }]));
    expect((await app.inject({ url: asset.url, headers: { cookie: otherCookie } })).statusCode).toBe(200);
});
it('导出 ZIP 使用相对图片引用，原图与 Markdown 一起打包', async () => {
    const owner = actor();
    const bytes = await image('webp', '#0878a0');
    const asset = (await upload(bytes)).json();
    const entity = { id: 'image-export', kind: 'object' as const, path: '设计/export.md', title: '图片导出', collection: null, fields: {}, body: '![示意图](' + asset.url + ')' };
    service.execute(owner, {}, () => service.mutate(owner, randomUUID(), [{ type: 'put', expected: null, entity }]));
    const response = await app.inject({ url: '/api/projects/demo/documents/image-export/export-images', headers: { cookie } });
    expect(response.statusCode, response.body).toBe(200);
    const files = unzipSync(response.rawPayload);
    expect(strFromU8(files['document.md'])).toContain('images/' + asset.id + '.webp');
    expect(Buffer.from(files['images/' + asset.id + '.webp'])).toEqual(bytes);
    expect(strFromU8(files['document.md'])).not.toContain('/api/projects/');
});
