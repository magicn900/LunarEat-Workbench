import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Fault } from './fault.js';
import { pdfExportLimits, type PdfInspection, type PdfTaskStatus } from '../shared/pdfExport.js';

const defaults = { waiting: 3, records: 8, diskBytes: 60 * 1024 * 1024, idleMs: 5 * 60000, hardMs: 15 * 60000, sweepMs: 10000, tombstoneMs: 60000, tombstones: 64 };
type Output = { bytes: Buffer; inspection: PdfInspection };
type Job = { key: string; taskId: string; state: PdfTaskStatus['state']; created: number; touched: number; controller: AbortController; item?: Work; completion?: Promise<void>; filename?: string; bytes: number; etag?: string; inspection?: PdfInspection; error?: string; errorStatus?: number; leases: number; expired: boolean };
type Work = { work: (signal: AbortSignal) => Promise<unknown>; controller: AbortController; signal?: AbortSignal; abort?: () => void; resolve: (result: unknown) => void; reject: (error: unknown) => void; job?: Job };

export class PdfJobs {
    private limits: typeof defaults;
    private jobs = new Map<string, Job>();
    private tombstones = new Map<string, number>();
    private queue: Work[] = [];
    private running: Work | null = null;
    private runningPromise: Promise<void> | null = null;
    private maintenance: Promise<void> = Promise.resolve();
    private directory: Promise<string> | null = null;
    private diskBytes = 0;
    private closing = false;
    private timer: NodeJS.Timeout;

    constructor(limits: Partial<typeof defaults> = {}) {
        this.limits = { ...defaults, ...limits };
        this.timer = setInterval(() => { void this.maintain().catch(() => {}); }, this.limits.sweepMs);
        this.timer.unref();
    }

    private key(owner: string, taskId: string) { return JSON.stringify([owner, taskId]); }
    private expires(job: Job) { return Math.min(job.created + this.limits.hardMs, job.touched + this.limits.idleMs); }
    private notFound() { return new Fault(404, 'PDF 任务已失效，请重新生成'); }
    private lookup(owner: string, taskId: string) {
        const job = this.jobs.get(this.key(owner, taskId));
        if (!job || job.expired || this.expires(job) <= Date.now()) throw this.notFound();
        return job;
    }
    private async deleteFile(job: Job) {
        if (!job.filename || job.leases) return;
        await unlink(job.filename).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
        this.diskBytes -= job.bytes; job.filename = undefined; job.bytes = 0;
    }
    private async remove(job: Job) {
        if (job.leases || job.item) return;
        await this.deleteFile(job); this.jobs.delete(job.key);
    }
    private cancelWork(item: Work) {
        item.controller.abort();
        const index = this.queue.indexOf(item);
        if (index >= 0) {
            this.queue.splice(index, 1); item.signal?.removeEventListener('abort', item.abort!);
            if (item.job) item.job.item = undefined;
            item.reject(item.controller.signal.reason);
        }
    }
    private async prune() {
        const now = Date.now();
        for (const [key, until] of this.tombstones) if (until <= now) this.tombstones.delete(key);
        for (const job of this.jobs.values()) {
            if (this.expires(job) <= now) {
                job.expired = true; job.state = 'cancelled'; job.controller.abort();
                if (job.item) this.cancelWork(job.item);
            }
            if ((job.expired || job.state === 'cancelled') && !job.leases && !job.item) await this.deleteFile(job);
            if (job.expired) await this.remove(job);
        }
    }
    private maintain(action?: () => Promise<void>) {
        const next = this.maintenance.then(async () => { await this.prune(); await action?.(); });
        this.maintenance = next.catch(() => {});
        return next;
    }
    private eviction(excluded?: Job) {
        return [...this.jobs.values()].filter(job => job !== excluded && !job.item && !job.leases).sort((left, right) => left.touched - right.touched)[0];
    }
    private enqueue<Result>(work: (signal: AbortSignal) => Promise<Result>, signal?: AbortSignal, job?: Job): Promise<Result> {
        if (this.closing) return Promise.reject(new Fault(503, 'PDF 服务正在关闭，请稍后重试'));
        if (signal?.aborted) return Promise.reject(signal.reason);
        if (this.running && this.queue.length >= this.limits.waiting) return Promise.reject(new Fault(429, 'PDF 导出队列已满，请稍后重试'));
        return new Promise<Result>((resolve, reject) => {
            const item: Work = { work, signal, controller: job?.controller || new AbortController(), resolve: result => resolve(result as Result), reject, job };
            item.abort = () => this.cancelWork(item);
            signal?.addEventListener('abort', item.abort, { once: true });
            if (job) job.item = item;
            this.queue.push(item); this.drain();
        });
    }
    private drain() {
        if (this.running || this.closing) return;
        const item = this.queue.shift();
        if (!item) return;
        this.running = item;
        if (item.job) item.job.state = 'rendering';
        const signal = AbortSignal.any([item.controller.signal, AbortSignal.timeout(pdfExportLimits.timeoutMs)]);
        this.runningPromise = (async () => {
            try { signal.throwIfAborted(); item.resolve(await item.work(signal)); }
            catch (error) {
                if (item.job && item.job.state !== 'cancelled') {
                    item.job.state = 'failed';
                    item.job.errorStatus = signal.aborted ? 504 : error instanceof Fault ? error.status : 500;
                    item.job.error = signal.aborted ? 'PDF 生成超时，请缩小导出范围后重试' : error instanceof Fault && (error.status < 500 || error.status === 503) ? error.message : 'PDF 生成失败，请重试';
                }
                item.reject(error);
            } finally {
                item.signal?.removeEventListener('abort', item.abort!);
                if (item.job) { item.job.item = undefined; item.job.touched = Date.now(); }
                this.running = null; this.runningPromise = null;
                void this.maintain().catch(() => {}); this.drain();
            }
        })();
    }
    run<Result>(work: (signal: AbortSignal) => Promise<Result>, signal?: AbortSignal) { return this.enqueue(work, signal); }

    async create(owner: string, taskId: string, work: (signal: AbortSignal) => Promise<Output>): Promise<PdfTaskStatus> {
        const key = this.key(owner, taskId);
        let accepted: Job | undefined;
        await this.maintain(async () => {
            if (this.closing) throw new Fault(503, 'PDF 服务正在关闭，请稍后重试');
            if (this.tombstones.has(key) || this.jobs.has(key)) throw new Fault(409, 'PDF 任务已取消或已存在，请重新生成');
            if (this.running && this.queue.length >= this.limits.waiting) throw new Fault(429, 'PDF 导出队列已满，请稍后重试');
            while (this.jobs.size >= this.limits.records) {
                const evicted = this.eviction();
                if (!evicted) throw new Fault(429, 'PDF 导出繁忙，请稍后重试');
                await this.remove(evicted);
            }
            if (this.closing) throw new Fault(503, 'PDF 服务正在关闭，请稍后重试');
            if (this.tombstones.has(key)) throw new Fault(409, 'PDF 任务已取消，请重新生成');
            const now = Date.now(), job: Job = { key, taskId, state: 'queued', created: now, touched: now, controller: new AbortController(), bytes: 0, leases: 0, expired: false };
            accepted = job; this.jobs.set(key, job);
            const pending = this.enqueue(async signal => {
                const output = await work(signal);
                signal.throwIfAborted();
                if (output.bytes.length > pdfExportLimits.pdfBytes) throw new Fault(413, '生成的 PDF 超过 30 MB，请缩小导出范围');
                await this.maintain(async () => {
                    signal.throwIfAborted();
                    while (this.diskBytes + output.bytes.length > this.limits.diskBytes) {
                        const evicted = this.eviction(job);
                        if (!evicted) throw new Fault(429, 'PDF 临时存储繁忙，请稍后重试');
                        await this.remove(evicted);
                    }
                    this.directory ||= mkdtemp(join(tmpdir(), 'workbench-pdf-jobs-')).then(async directory => { await chmod(directory, 0o700); return directory; });
                    const filename = join(await this.directory, randomUUID() + '.pdf');
                    try {
                        await writeFile(filename, output.bytes, { mode: 0o600, signal }); signal.throwIfAborted();
                    } catch (error) { await unlink(filename).catch(() => {}); throw error; }
                    job.filename = filename; job.bytes = output.bytes.length; this.diskBytes += job.bytes;
                    job.etag = '"' + createHash('sha256').update(output.bytes).digest('hex') + '"';
                    job.inspection = output.inspection; job.state = 'ready'; job.touched = Date.now();
                });
            }, undefined, job);
            job.completion = pending; void pending.catch(() => {});
        });
        return this.manifest(accepted!);
    }
    private manifest(job: Job): PdfTaskStatus {
        return { taskId: job.taskId, state: job.state, position: job.state === 'queued' && job.item ? this.queue.indexOf(job.item) + 1 : undefined, bytes: job.state === 'ready' ? job.bytes : undefined, etag: job.etag, inspection: job.inspection, expiresAt: this.expires(job), error: job.error, errorStatus: job.errorStatus };
    }
    async status(owner: string, taskId: string) {
        await this.maintain(); const job = this.lookup(owner, taskId); job.touched = Date.now(); return this.manifest(job);
    }
    async runFile(work: (signal: AbortSignal) => Promise<Output>, signal: AbortSignal) {
        signal.throwIfAborted();
        const owner = 'legacy:' + randomUUID(), taskId = randomUUID();
        const abort = () => { void this.cancel(owner, taskId).catch(() => {}); };
        signal.addEventListener('abort', abort, { once: true });
        let file: Awaited<ReturnType<PdfJobs['acquire']>> | undefined;
        try {
            await this.create(owner, taskId, work); signal.throwIfAborted();
            await this.lookup(owner, taskId).completion; signal.throwIfAborted();
            file = await this.acquire(owner, taskId); await this.cancel(owner, taskId); signal.throwIfAborted();
            return file;
        } catch (error) { file?.release(); await this.cancel(owner, taskId); throw error; }
        finally { signal.removeEventListener('abort', abort); }
    }
    async acquire(owner: string, taskId: string) {
        await this.maintain(); const job = this.lookup(owner, taskId);
        if (job.state !== 'ready' || !job.filename) throw this.notFound();
        job.touched = Date.now(); job.leases++;
        let released = false;
        return { filename: job.filename, bytes: job.bytes, etag: job.etag!, inspection: job.inspection!, release: () => { if (!released) { released = true; job.leases--; void this.maintain().catch(() => {}); } } };
    }
    async cancel(owner: string, taskId: string) {
        const key = this.key(owner, taskId);
        this.tombstones.delete(key); this.tombstones.set(key, Date.now() + this.limits.tombstoneMs);
        while (this.tombstones.size > this.limits.tombstones) this.tombstones.delete(this.tombstones.keys().next().value!);
        const job = this.jobs.get(key);
        if (job) { job.state = 'cancelled'; job.controller.abort(); if (job.item) this.cancelWork(job.item); }
        await this.maintain();
    }
    async close() {
        this.closing = true; clearInterval(this.timer);
        for (const item of [...this.queue]) { if (item.job) item.job.state = 'cancelled'; this.cancelWork(item); }
        this.running?.controller.abort(); await this.runningPromise;
        await this.maintain(async () => { for (const job of this.jobs.values()) { if (job.leases) throw Error('PDF transfer is still active'); await this.remove(job); } });
        if (this.directory) await rmdir(await this.directory);
    }
}
