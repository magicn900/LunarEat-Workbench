import { beforeAll, afterAll, it, expect } from 'vitest';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import sharp from 'sharp';
import { Store } from '../src/server/store';
import { createCodec, type Codec } from '../src/server/codec';
import { Service } from '../src/server/service';
import { createApp } from '../src/server/app';
import { seed } from '../src/server/seed';

let directory: string, store: Store, codec: Codec, app: Awaited<ReturnType<typeof createApp>>, origin: string, cookie: string, otherCookie: string, bytes: Buffer;
const path = '/api/projects/demo/documents/overview/images';
const pending = new Map<string, (request: FastifyRequest) => void>();
const clients = new Set<ClientRequest>();
const headers = (session = cookie) => ({ cookie: session, 'x-workbench-client': 'test', 'content-type': 'application/octet-stream' });
beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-upload-lifecycle-'));
    store = new Store(directory); seed(store, 'upload-lifecycle-password-123'); codec = await createCodec();
    app = await createApp(new Service(store, codec));
    app.addHook('preParsing', async (request, _reply, payload) => { pending.get(String(request.headers['x-test-upload']))?.(request); return payload; });
    origin = await app.listen({ port: 0, host: '127.0.0.1' });
    for (const username of ['designer', 'developer']) {
        const response = await app.inject({ method: 'POST', url: '/api/login', headers: { 'x-workbench-client': 'test' }, payload: { username, password: 'upload-lifecycle-password-123' } });
        expect(response.statusCode).toBe(200);
        const session = response.headers['set-cookie']!.toString().split(';')[0];
        if (username === 'designer') cookie = session; else otherCookie = session;
    }
    bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#4179aa' } }).png().toBuffer();
});
afterAll(async () => {
    clients.forEach(client => client.destroy()); pending.clear();
    await app?.close(); await codec?.close(); store?.close();
    if (directory?.startsWith(join(tmpdir(), 'workbench-upload-lifecycle-'))) rmSync(directory, { recursive: true, force: true });
});
async function hold() {
    const marker = randomUUID();
    let rejectAdmission: (error: Error) => void = () => {};
    const admitted = new Promise<FastifyRequest>((resolve, reject) => { pending.set(marker, resolve); rejectAdmission = reject; });
    const client = httpRequest(origin + path, { method: 'POST', headers: { ...headers(), 'content-length': bytes.length + 100, 'x-test-upload': marker } });
    clients.add(client);
    client.on('error', rejectAdmission);
    client.on('response', response => { response.resume(); rejectAdmission(Error('Upload was rejected before body parsing: ' + response.statusCode)); });
    client.once('close', () => clients.delete(client));
    client.write(bytes.subarray(0, 8));
    try {
        const request = await admitted;
        const closed = new Promise<void>(resolve => request.raw.once('close', resolve));
        return { abort: async () => { client.destroy(); await closed; expect(request.raw.aborted).toBe(true); } };
    } finally { pending.delete(marker); }
}
const upload = async (session = otherCookie, body = bytes) => {
    const response = await fetch(origin + path, { method: 'POST', headers: headers(session), body: new Uint8Array(body) });
    await response.arrayBuffer(); return response.status;
};
it('中断真实上传后其他用户可重试，释放幂等且仍严格限制两个并发', async () => {
    for (const round of [1, 2, 3]) {
        const first = await hold(), second = await hold();
        try { expect(await upload(), '第三个上传应被拒绝，轮次 ' + round).toBe(429); }
        finally { await Promise.all([first.abort(), second.abort()]); }
        expect(await upload(), '中断后应释放名额，轮次 ' + round).toBe(200);
        expect(await upload(cookie, Buffer.from('invalid image'))).toBe(400);
        expect(await upload(cookie)).toBe(200);
    }
});
