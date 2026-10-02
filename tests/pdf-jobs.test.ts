import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { PdfJobs } from '../src/server/pdfJobs';
import type { PdfInspection } from '../src/shared/pdfExport';

const inspection: PdfInspection = { title: 'Original', head: 'pinned', at: '2026-10-01T10:00:00.000Z', source: 'draft', views: [], warnings: [] };
const result = (size = 24) => ({ bytes: Buffer.alloc(size, 65), inspection });
const managers: PdfJobs[] = [];
const manager = (limits: ConstructorParameters<typeof PdfJobs>[0] = {}) => { const jobs = new PdfJobs(limits); managers.push(jobs); return jobs; };
const deferred = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
afterEach(async () => { await Promise.all(managers.splice(0).map(jobs => jobs.close())); });

it('shares one render slot with legacy work and does not load queued jobs', async () => {
    const jobs = manager(), gate = deferred(), work = vi.fn(async () => result());
    const legacy = jobs.run(async () => { await gate.promise; return 'legacy'; });
    const taskId = randomUUID();
    expect((await jobs.create('owner', taskId, work)).state).toBe('queued');
    expect((await jobs.status('owner', taskId)).position).toBe(1);
    expect(work).not.toHaveBeenCalled();
    gate.release();
    expect(await legacy).toBe('legacy');
    await vi.waitFor(async () => expect((await jobs.status('owner', taskId)).state).toBe('ready'));
    expect(work).toHaveBeenCalledTimes(1);
});

it('cancels queued and late-arriving tasks without affecting another owner', async () => {
    const jobs = manager(), gate = deferred(), work = vi.fn(async () => result());
    const legacy = jobs.run(async () => { await gate.promise; });
    const taskId = randomUUID();
    await jobs.cancel('owner', taskId);
    await expect(jobs.create('owner', taskId, work)).rejects.toMatchObject({ status: 409 });
    await jobs.create('another-owner', taskId, work);
    await jobs.cancel('another-owner', taskId);
    gate.release(); await legacy;
    expect(work).not.toHaveBeenCalled();
    expect((await jobs.status('another-owner', taskId)).state).toBe('cancelled');
});

it('holds the slot until an aborted renderer actually exits', async () => {
    const jobs = manager(), started = deferred(), stopped = deferred(), next = vi.fn(async () => result());
    const taskId = randomUUID();
    await jobs.create('owner', taskId, async signal => { started.release(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); await stopped.promise; signal.throwIfAborted(); return result(); });
    await started.promise;
    const nextId = randomUUID(); await jobs.create('owner', nextId, next);
    await jobs.cancel('owner', taskId);
    expect(next).not.toHaveBeenCalled();
    expect((await jobs.status('owner', nextId)).state).toBe('queued');
    stopped.release();
    await vi.waitFor(async () => expect((await jobs.status('owner', nextId)).state).toBe('ready'));
    expect(next).toHaveBeenCalledTimes(1);
});

it('stores original bytes privately, isolates owners, and defers expiry unlink until transfer release', async () => {
    const jobs = manager({ idleMs: 80, hardMs: 150, sweepMs: 10 }), taskId = randomUUID();
    const original = result(); await jobs.create('owner/project/doc', taskId, async () => original);
    await vi.waitFor(async () => expect((await jobs.status('owner/project/doc', taskId)).state).toBe('ready'));
    await expect(jobs.acquire('other/project/doc', taskId)).rejects.toMatchObject({ status: 404 });
    const file = await jobs.acquire('owner/project/doc', taskId);
    expect(await readFile(file.filename)).toEqual(original.bytes);
    expect(file.etag).toMatch(/^"[a-f0-9]{64}"$/);
    await new Promise(resolve => setTimeout(resolve, 180));
    await expect(jobs.acquire('owner/project/doc', taskId)).rejects.toMatchObject({ status: 404 });
    await expect(access(file.filename)).resolves.toBeUndefined();
    file.release();
    await vi.waitFor(async () => expect(await access(file.filename).then(() => true, () => false)).toBe(false));
});

it('bounds stored bytes without evicting an active transfer', async () => {
    const jobs = manager({ diskBytes: 30 }), firstId = randomUUID(), nextId = randomUUID();
    await jobs.create('owner', firstId, async () => result(20));
    await vi.waitFor(async () => expect((await jobs.status('owner', firstId)).state).toBe('ready'));
    const file = await jobs.acquire('owner', firstId);
    await jobs.create('owner', nextId, async () => result(20));
    await vi.waitFor(async () => expect((await jobs.status('owner', nextId)).state).toBe('failed'));
    expect(await readFile(file.filename)).toHaveLength(20);
    file.release();
    const recoveredId = randomUUID(); await jobs.create('owner', recoveredId, async () => result(20));
    await vi.waitFor(async () => expect((await jobs.status('owner', recoveredId)).state).toBe('ready'));
    await expect(jobs.status('owner', firstId)).rejects.toMatchObject({ status: 404 });
});

it('bounds waiting work, hides internal errors and recovers after failure', async () => {
    const jobs = manager({ waiting: 1 }), gate = deferred();
    const running = jobs.run(async () => { await gate.promise; });
    await jobs.create('owner', randomUUID(), async () => result());
    await expect(jobs.create('owner', randomUUID(), async () => result())).rejects.toMatchObject({ status: 429 });
    gate.release(); await running;
    const failedId = randomUUID();
    await jobs.create('owner', failedId, async () => { throw Error('secret internal path'); });
    await vi.waitFor(async () => expect((await jobs.status('owner', failedId)).state).toBe('failed'));
    expect((await jobs.status('owner', failedId)).error).not.toContain('secret');
    const recoveredId = randomUUID(); await jobs.create('owner', recoveredId, async () => result());
    await vi.waitFor(async () => expect((await jobs.status('owner', recoveredId)).state).toBe('ready'));
});

it('serializes concurrent admission, rejects duplicate IDs, and keeps the record limit bounded', async () => {
    const jobs = manager({ records: 2, waiting: 1 }), gate = deferred(), taskId = randomUUID();
    const accepted = jobs.create('owner', taskId, async () => { await gate.promise; return result(); });
    const duplicate = jobs.create('owner', taskId, async () => result());
    await accepted; await expect(duplicate).rejects.toMatchObject({ status: 409 });
    const queued = await jobs.create('owner', randomUUID(), async () => result()); expect(queued.state).toBe('queued');
    await expect(jobs.create('owner', randomUUID(), async () => result())).rejects.toMatchObject({ status: 429 });
    gate.release();
    await vi.waitFor(async () => expect((await jobs.status('owner', queued.taskId)).state).toBe('ready'));
});

it('streams legacy results from bounded private disk and removes them after transfer release', async () => {
    const jobs = manager(), file = await jobs.runFile(async () => result(), new AbortController().signal);
    expect(await readFile(file.filename)).toEqual(result().bytes);
    await expect(access(file.filename)).resolves.toBeUndefined(); file.release();
    await vi.waitFor(async () => expect(await access(file.filename).then(() => true, () => false)).toBe(false));
});
