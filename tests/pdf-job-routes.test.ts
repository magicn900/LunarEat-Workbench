import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/server/store';
import { Service } from '../src/server/service';
import { createCodec, type Codec } from '../src/server/codec';
import { createApp } from '../src/server/app';
import { seed } from '../src/server/seed';
import { actorFor } from '../src/server/auth';
import * as renderer from '../src/server/pdfRenderer';

let directory: string, store: Store, codec: Codec, service: Service, app: Awaited<ReturnType<typeof createApp>>, cookie: string, otherCookie: string;
const endpoint = '/api/projects/demo/documents/overview/export-pdf/tasks';
const bytes = Buffer.from('%PDF-pinned-original-bytes');
const headers = () => ({ cookie, 'x-workbench-client': 'test' });
const head = () => service.workspace(actorFor(store, cookie.replace('session=', ''), false, 'demo')).head;
beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-pdf-tasks-')); store = new Store(directory); seed(store, 'task-password-123'); codec = await createCodec(); service = new Service(store, codec); app = await createApp(service);
    for (const username of ['designer', 'developer']) {
        const response = await app.inject({ method: 'POST', url: '/api/login', headers: { 'x-workbench-client': 'test' }, payload: { username, password: 'task-password-123' } });
        const session = response.headers['set-cookie']!.toString().split(';')[0];
        if (username === 'designer') cookie = session; else otherCookie = session;
    }
    vi.spyOn(renderer, 'renderPdf').mockResolvedValue(bytes);
});
afterAll(async () => {
    await app?.close(); await codec?.close(); store?.close(); vi.restoreAllMocks();
    if (directory) { const target = resolve(directory); if (dirname(target) === resolve(tmpdir()) && basename(target).startsWith('workbench-pdf-tasks-')) rmSync(target, { recursive: true, force: true }); }
});
async function ready() {
    const taskId = randomUUID(), response = await app.inject({ method: 'POST', url: endpoint, headers: headers(), payload: { taskId, head: head() } });
    expect(response.statusCode, response.body).toBe(202);
    await vi.waitFor(async () => expect((await app.inject({ method: 'GET', url: endpoint + '/' + taskId, headers: headers() })).json().state).toBe('ready'));
    return endpoint + '/' + taskId;
}

it('validates authentication, snapshot and task IDs', async () => {
    expect((await app.inject({ method: 'POST', url: endpoint, headers: { 'x-workbench-client': 'test' }, payload: { taskId: randomUUID(), head: head() } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: endpoint, headers: headers(), payload: { taskId: randomUUID(), head: 'stale' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: endpoint, headers: headers(), payload: { taskId: '../escape', head: head() } })).statusCode).toBe(400);
});

it('serves original full, HEAD and range bytes with a strong ETag without rerendering', async () => {
    const before = vi.mocked(renderer.renderPdf).mock.calls.length, task = await ready(), file = task + '/file';
    const full = await app.inject({ method: 'GET', url: file, headers: headers() });
    expect(full.statusCode).toBe(200); expect(full.rawPayload).toEqual(bytes);
    expect(full.headers['accept-ranges']).toBe('bytes'); expect(full.headers['cache-control']).toBe('no-store');
    expect(full.headers.etag).toMatch(/^"[a-f0-9]{64}"$/);
    const metadata = await app.inject({ method: 'HEAD', url: file, headers: headers() });
    expect(metadata.statusCode).toBe(200); expect(Number(metadata.headers['content-length'])).toBe(bytes.length); expect(metadata.body).toBe('');
    for (const [range, start, end] of [['bytes=0-4', 0, 4], ['bytes=5-', 5, bytes.length - 1], ['bytes=-3', bytes.length - 3, bytes.length - 1], ['bytes=4-999', 4, bytes.length - 1]] as const) {
        const partial = await app.inject({ method: 'GET', url: file, headers: { ...headers(), range, 'if-range': full.headers.etag! } });
        expect(partial.statusCode, partial.body).toBe(206); expect(partial.rawPayload).toEqual(bytes.subarray(start, end + 1));
        expect(partial.headers['content-range']).toBe(`bytes ${start}-${end}/${bytes.length}`);
    }
    const changed = await app.inject({ method: 'GET', url: file, headers: { ...headers(), range: 'bytes=0-4', 'if-range': '"different"' } });
    expect(changed.statusCode).toBe(200); expect(changed.rawPayload).toEqual(bytes);
    expect(vi.mocked(renderer.renderPdf).mock.calls.length - before).toBe(1);
});

it('rejects invalid ranges and isolates owners, documents, origins and disabled accounts', async () => {
    const task = await ready(), file = task + '/file';
    for (const range of ['bytes=999-', 'bytes=8-4', 'bytes=0-1,4-5', 'bytes=-0', 'other=0-4']) {
        const response = await app.inject({ method: 'GET', url: file, headers: { ...headers(), range } });
        expect(response.statusCode).toBe(416); expect(response.headers['content-range']).toBe('bytes */' + bytes.length);
    }
    expect((await app.inject({ method: 'GET', url: file, headers: { ...headers(), cookie: otherCookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: file.replace('/overview/', '/other-document/'), headers: headers() })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: file, headers: { ...headers(), origin: 'https://untrusted.invalid' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: file, headers: { ...headers(), 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(403);
    const userId = actorFor(store, cookie.replace('session=', ''), false, 'demo').userId;
    store.db.prepare('INSERT INTO account_access(user_id,disabled,administrator) VALUES(?,1,0) ON CONFLICT(user_id) DO UPDATE SET disabled=1').run(userId);
    try { expect((await app.inject({ method: 'GET', url: file, headers: headers() })).statusCode).toBe(401); }
    finally { store.db.prepare('UPDATE account_access SET disabled=0 WHERE user_id=?').run(userId); }
});

it('prevents a cancelled late POST from reviving and does not let another user cancel', async () => {
    const taskId = randomUUID();
    expect((await app.inject({ method: 'DELETE', url: endpoint + '/' + taskId, headers: headers() })).statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: endpoint, headers: headers(), payload: { taskId, head: head() } })).statusCode).toBe(409);
    const task = await ready();
    expect((await app.inject({ method: 'DELETE', url: task, headers: { ...headers(), cookie: otherCookie } })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: task + '/file', headers: headers() })).statusCode).toBe(200);
    await app.inject({ method: 'DELETE', url: task, headers: headers() });
    expect((await app.inject({ method: 'GET', url: task + '/file', headers: headers() })).statusCode).toBe(404);
});

it('renders the accepted immutable snapshot even if the workspace changes while queued', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(renderer.renderPdf).mockImplementationOnce(async () => { await gate; return bytes; });
    const pinned = head(), firstId = randomUUID(), queuedId = randomUUID();
    const first = await app.inject({ method: 'POST', url: endpoint, headers: headers(), payload: { taskId: firstId, head: pinned } }); expect(first.statusCode).toBe(202);
    const queued = await app.inject({ method: 'POST', url: endpoint, headers: headers(), payload: { taskId: queuedId, head: pinned } }); expect(queued.json().state).toBe('queued');
    const current = actorFor(store, cookie.replace('session=', ''), false, 'demo'), document = store.entity(pinned, 'overview');
    if (document?.kind !== 'object') throw Error('fixture');
    service.execute(current, {}, () => service.mutate(current, randomUUID(), [{ type: 'put', expected: document, entity: { ...document, title: 'Changed after queueing', body: 'Do not mix new content into the old PDF' } }]));
    release();
    await vi.waitFor(async () => {
        const status = (await app.inject({ method: 'GET', url: endpoint + '/' + queuedId, headers: headers() })).json();
        expect(status.state).toBe('ready'); expect(status.inspection).toMatchObject({ head: pinned, title: document.title });
    });
    expect(vi.mocked(renderer.renderPdf).mock.calls.at(-1)![0]).not.toContain('Do not mix new content');
    expect(head()).not.toBe(pinned);
});

it('rechecks permissions after rendering and never delivers a revoked task', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(renderer.renderPdf).mockImplementationOnce(async () => { await gate; return bytes; });
    const taskId = randomUUID(), task = endpoint + '/' + taskId;
    expect((await app.inject({ method: 'POST', url: endpoint, headers: headers(), payload: { taskId, head: head() } })).statusCode).toBe(202);
    await vi.waitFor(async () => expect((await app.inject({ method: 'GET', url: task, headers: headers() })).json().state).toBe('rendering'));
    const userId = actorFor(store, cookie.replace('session=', ''), false, 'demo').userId;
    store.db.prepare('UPDATE account_access SET disabled=1 WHERE user_id=?').run(userId); release();
    try { await vi.waitFor(() => expect(vi.mocked(renderer.renderPdf).mock.results.at(-1)?.type).toBe('return')); await new Promise(resolve => setTimeout(resolve, 60)); }
    finally { store.db.prepare('UPDATE account_access SET disabled=0 WHERE user_id=?').run(userId); }
    await vi.waitFor(async () => expect((await app.inject({ method: 'GET', url: task, headers: headers() })).json()).toMatchObject({ state: 'failed', errorStatus: 401 }));
    expect((await app.inject({ method: 'GET', url: task + '/file', headers: headers() })).statusCode).toBe(404);
    await ready();
});
