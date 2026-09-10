import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { request as httpRequest, type ClientRequest } from 'node:http';
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
import { saveImage } from '../src/server/assets';
let directory: string, store: Store, codec: Codec, app: Awaited<ReturnType<typeof createApp>>, origin: string, cookie: string, otherCookie: string;
const clients = new Set<ClientRequest>();
const closed = new Map<string, () => void>();
const preparing = new Map<string, { started: () => void; gate: Promise<void> }>();
const path = '/api/projects/demo/documents/export-large/export-images';
beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-export-lifecycle-'));
    store = new Store(directory); seed(store, 'export-lifecycle-password-123'); codec = await createCodec();
    const service = new Service(store, codec); app = await createApp(service);
    app.addHook('onRequest', async (request, reply) => { reply.raw.once('close', () => closed.get(String(request.headers['x-test-export']))?.()); });
    app.addHook('preHandler', async request => {
        const pending = preparing.get(String(request.headers['x-test-export']));
        if (pending) { pending.started(); await pending.gate; }
    });
    origin = await app.listen({ port: 0, host: '127.0.0.1' });
    for (const username of ['designer', 'developer']) {
        const response = await app.inject({ method: 'POST', url: '/api/login', headers: { 'x-workbench-client': 'test' }, payload: { username, password: 'export-lifecycle-password-123' } });
        expect(response.statusCode).toBe(200); const session = response.headers['set-cookie']!.toString().split(';')[0];
        if (username === 'designer') cookie = session; else otherCookie = session;
    }
    const owner = actorFor(store, cookie.slice('session='.length), false, 'demo'), references: string[] = [];
    for (let index = 0; index < 5; index++) {
        const asset = saveImage(store, owner, Buffer.alloc(9 * 1024 * 1024, index), 'fixture.png', { mime: 'image/png', extension: 'png', width: 1, height: 1 });
        references.push('![](' + asset.url + ')');
    }
    service.execute(owner, {}, () => service.mutate(owner, randomUUID(), [{ type: 'put', expected: null, entity: { id: 'export-large', kind: 'object', path: '设计/export-large.md', title: '导出', collection: null, fields: {}, body: references.join('\n\n') } }]));
});
afterAll(async () => {
    clients.forEach(client => client.destroy()); await app?.close(); await codec?.close(); store?.close();
    if (directory?.startsWith(join(tmpdir(), 'workbench-export-lifecycle-'))) rmSync(directory, { recursive: true, force: true });
});
async function hold() {
    const marker = randomUUID();
    const finished = new Promise<void>(resolve => closed.set(marker, resolve));
    const client = httpRequest(origin + path, { headers: { cookie, 'x-test-export': marker } }); clients.add(client);
    client.once('close', () => clients.delete(client));
    const response = new Promise<void>((resolve, reject) => {
        client.on('error', reject);
        client.on('response', incoming => { incoming.pause(); if (incoming.statusCode === 200) resolve(); else reject(Error('Unexpected status: ' + incoming.statusCode)); });
    });
    client.end(); await response;
    return async () => { client.destroy(); await finished; closed.delete(marker); };
}
it('慢下载保持独立并发限制，中断后跨账号请求恢复且上传不受阻塞', async () => {
    for (let round = 0; round < 3; round++) {
        const first = await hold(), second = await hold();
        try {
            const busy = await fetch(origin + path, { headers: { cookie } }); expect(busy.status).toBe(429); await busy.arrayBuffer();
            expect((await fetch(origin + '/api/health')).status).toBe(200);
            const upload = await fetch(origin + '/api/projects/demo/documents/overview/images', { method: 'POST', headers: { cookie: otherCookie, 'x-workbench-client': 'test', 'content-type': 'application/octet-stream' }, body: 'invalid' });
            expect(upload.status).toBe(400); await upload.arrayBuffer();
        } finally { await Promise.all([first(), second()]); }
        const next = await fetch(origin + '/api/projects/demo/documents/overview/export-images', { headers: { cookie: otherCookie } });
        expect(next.status).toBe(200); await next.arrayBuffer();
    }
});
it('导出准备阶段取消后不再执行处理器，也不记录伪服务端错误', async () => {
    const marker = randomUUID(), errors = vi.spyOn(console, 'error');
    let release: () => void = () => {}, started: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; }), admitted = new Promise<void>(resolve => { started = resolve; });
    preparing.set(marker, { gate, started });
    const finished = new Promise<void>(resolve => closed.set(marker, resolve));
    const client = httpRequest(origin + path, { headers: { cookie, 'x-test-export': marker } }); clients.add(client);
    client.on('error', () => {}); client.once('close', () => clients.delete(client)); client.end();
    try {
        await admitted; client.destroy(); await finished; release();
        const response = await fetch(origin + '/api/projects/demo/documents/overview/export-images', { headers: { cookie: otherCookie } });
        expect(response.status).toBe(200); await response.arrayBuffer(); expect(errors).not.toHaveBeenCalled();
    } finally { release(); client.destroy(); preparing.delete(marker); closed.delete(marker); errors.mockRestore(); }
});
