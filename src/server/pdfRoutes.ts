import type { FastifyInstance, FastifyReply } from 'fastify';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { actorFor, Fault, requireScope } from './auth.js';
import { projectState } from './projectState.js';
import { readableAsset, assetPath } from './assets.js';
import { assetReference } from '../shared/assets.js';
import { pdfRequestSchema, pdfExportLimits, pdfFilename, pdfSnapshotDate, type PdfRequest } from '../shared/pdfExport.js';
import { preparePdfDocument, type PdfContext, type PdfImage } from './pdfDocument.js';
import { renderPdf } from './pdfRenderer.js';
import { pdfImageOrigin, type PdfImageResource } from './pdfResources.js';
import { PdfJobs } from './pdfJobs.js';
import type { Service } from './service.js';
import type { Actor } from '../shared/model.js';

export function registerPdfRoutes(app: FastifyInstance, service: Service) {
    let inspections = 0;
    const jobs = new PdfJobs();
    app.addHook('onClose', async () => { await jobs.close(); });
    const parameters = z.object({ projectId: z.string().min(1).max(150), documentId: z.string().min(1).max(150) });
    const identify = (request: { params: unknown; headers: Record<string, any>; cookies: Record<string, string | undefined> }) => {
        const { projectId, documentId } = parameters.parse(request.params);
        const actor = actorFor(service.store, request.headers.authorization?.replace(/^Bearer /, '') || request.cookies.session || '', !!request.headers.authorization, projectId);
        if (actor.projectId !== projectId) throw new Fault(404, '项目不存在或无权访问');
        requireScope(actor, 'workspace.read');
        return { actor, projectId, documentId };
    };
    const capture = (actor: Actor, input: PdfRequest, origin: string): Omit<PdfContext, 'signal' | 'inspectionOnly'> => {
        const workspace = service.workspace(actor);
        if (workspace.head !== input.head) throw new Fault(409, '文档或集合已变化，请刷新导出快照');
        const revision = service.store.db.prepare('SELECT id FROM revisions WHERE project_id=? AND tree=? ORDER BY created DESC LIMIT 1').get(actor.projectId, workspace.head) as { id: string } | undefined;
        const source = revision ? (input.options.language === 'en' ? 'Published version ' : '正式版本 ') + revision.id.slice(0, 12) : input.options.language === 'en' ? 'Personal draft' : '个人草稿';
        return { head: workspace.head, at: input.at || new Date().toISOString(), timeZone: input.timeZone, project: projectState(service.store, actor.projectId), origin, source };
    };
    const prepare = async (actor: Actor, documentId: string, input: PdfRequest, pinned: Omit<PdfContext, 'signal' | 'inspectionOnly'>, signal: AbortSignal, images: boolean) => {
        signal.throwIfAborted();
        const tree = service.store.tree(pinned.head);
        const context: PdfContext = { ...pinned, signal, inspectionOnly: !images };
        const origin = pinned.origin;
        let imageBytes = 0;
        const cache = new Map<string, Promise<PdfImage>>();
        const resources = new Map<string, PdfImageResource>();
        const job = randomUUID();
        const resolve = (source: string): Promise<PdfImage> => {
            const reference = assetReference(source);
            let sameOrigin = false;
            try { sameOrigin = new URL(source, origin).origin === origin; } catch {}
            if (!reference || !sameOrigin) return Promise.resolve({ error: input.options.language === 'en' ? 'External images are not fetched automatically' : '外部图片不自动下载' });
            if (reference.projectId !== actor.projectId) return Promise.resolve({ error: input.options.language === 'en' ? 'Image unavailable' : '图片不存在或无权访问' });
            const cached = cache.get(reference.id);
            if (cached) return cached;
            const image = (async (): Promise<PdfImage> => {
                let asset: ReturnType<typeof readableAsset>;
                try { asset = readableAsset(service.store, actor, reference.id); }
                catch { return { error: input.options.language === 'en' ? 'Image unavailable' : '图片不存在或无权访问' }; }
                const filename = assetPath(service.store, asset);
                let size: number;
                try { const info = await stat(filename); if (!info.isFile() || info.size !== asset.size) throw Error('missing'); size = info.size; }
                catch { return { error: input.options.language === 'en' ? 'Image file missing or changed' : '图片文件缺失或已变化' }; }
                imageBytes += size;
                if (imageBytes > pdfExportLimits.imageBytes) throw new Fault(413, '单次图片导出不能超过 50 MB');
                signal.throwIfAborted();
                if (!images) return { source: 'data:' + asset.mime + ';base64,' };
                try {
                    const bytes = await readFile(filename, { signal });
                    if (bytes.length !== size) throw Error('changed');
                    const url = pdfImageOrigin + '/' + job + '/' + asset.id;
                    resources.set(url, { mime: asset.mime, bytes });
                    return { source: url };
                }
                catch { signal.throwIfAborted(); return { error: input.options.language === 'en' ? 'Image file missing or changed' : '图片文件缺失或已变化' }; }
            })();
            cache.set(reference.id, image);
            return image;
        };
        return { ...await preparePdfDocument(tree, documentId, context, input.options, resolve), resources };
    };
    const endpoint = '/api/projects/:projectId/documents/:documentId/export-pdf';
    const originFor = (request: { protocol: string; headers: { host?: string } }) => new URL(process.env.WORKBENCH_ORIGIN || request.protocol + '://' + request.headers.host).origin;
    const ownerFor = (actor: Actor, documentId: string) => JSON.stringify([actor.kind, actor.userId, actor.kind === 'agent' ? actor.sessionId : null, actor.projectId, documentId]);
    const render = async (actor: Actor, documentId: string, input: PdfRequest, pinned: Omit<PdfContext, 'signal' | 'inspectionOnly'>, signal: AbortSignal) => {
        const prepared = await prepare(actor, documentId, input, pinned, signal, true);
        if (prepared.inspection.warnings.length && !input.options.allowIncomplete) throw new Fault(422, '导出包含不可用内容，请确认后带缺失标记继续', { warnings: prepared.inspection.warnings });
        const bytes = await renderPdf(prepared.html, input.options, prepared.inspection.source + ' · ' + pdfSnapshotDate(prepared.inspection.at, input.timeZone), signal, prepared.resources);
        return { bytes, inspection: prepared.inspection };
    };
    const sendFile = (file: Awaited<ReturnType<PdfJobs['acquire']>>, reply: FastifyReply, start = 0, end = file.bytes - 1) => {
        const stream = createReadStream(file.filename, { start, end });
        const abort = () => stream.destroy();
        reply.raw.once('close', abort);
        stream.once('close', () => { reply.raw.removeListener('close', abort); file.release(); });
        return reply.send(stream);
    };
    for (const inspection of [true, false]) app.post(endpoint + (inspection ? '/inspect' : ''), async (request, reply) => {
        const { actor, documentId } = identify(request);
        const input = pdfRequestSchema.parse(request.body);
        const pinned = capture(actor, input, originFor(request));
        if (inspection && inspections >= 2) throw new Fault(429, 'PDF 预检繁忙，请稍后重试');
        if (inspection) inspections++;
        const controller = new AbortController();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(pdfExportLimits.timeoutMs)]);
        const abort = () => controller.abort();
        reply.raw.once('close', abort);
        request.raw.once('aborted', abort);
        try {
            if (inspection) return (await prepare(actor, documentId, input, pinned, signal, false)).inspection;
            const file = await jobs.runFile(async rendering => {
                const output = await render(identify(request).actor, documentId, input, pinned, rendering); identify(request); return output;
            }, signal);
            try {
                identify(request);
                reply.type('application/pdf').header('Content-Length', file.bytes).header('Content-Disposition', "inline; filename=document.pdf; filename*=UTF-8''" + encodeURIComponent(pdfFilename(file.inspection.title)));
                return sendFile(file, reply);
            } catch (error) { file.release(); throw error; }
        } catch (error) {
            if (controller.signal.aborted) return reply;
            if (signal.aborted) return reply.code(504).send({ error: 'PDF 生成超时，请缩小导出范围后重试', requestId: request.id });
            if (error instanceof Fault && error.status === 503) return reply.code(503).send({ error: error.message, requestId: request.id });
            throw error;
        } finally {
            if (inspection) inspections--;
            reply.raw.removeListener('close', abort);
            request.raw.removeListener('aborted', abort);
        }
    });
    const taskParameters = parameters.extend({ taskId: z.string().uuid() });
    app.post(endpoint + '/tasks', async (request, reply) => {
        const { actor, documentId } = identify(request);
        const input = pdfRequestSchema.extend({ taskId: z.string().uuid() }).parse(request.body);
        const pinned = capture(actor, input, originFor(request));
        const manifest = await jobs.create(ownerFor(actor, documentId), input.taskId, async signal => {
            const output = await render(identify(request).actor, documentId, input, pinned, signal);
            identify(request); signal.throwIfAborted(); return output;
        });
        return reply.code(202).send(manifest);
    });
    const taskOwner = (request: Parameters<typeof identify>[0] & { protocol: string }) => {
        if (request.headers.origin && request.headers.origin !== originFor(request)) throw new Fault(403, '请求来源不可信');
        if (request.headers['sec-fetch-site'] === 'cross-site') throw new Fault(403, '禁止跨站读取 PDF');
        const { actor, documentId } = identify(request);
        return { owner: ownerFor(actor, documentId), taskId: taskParameters.parse(request.params).taskId };
    };
    app.get(endpoint + '/tasks/:taskId', async request => {
        const { owner, taskId } = taskOwner(request);
        const manifest = await jobs.status(owner, taskId); identify(request); return manifest;
    });
    app.delete(endpoint + '/tasks/:taskId', async (request, reply) => {
        const { owner, taskId } = taskOwner(request); await jobs.cancel(owner, taskId); return reply.code(204).send();
    });
    app.route({ method: ['GET', 'HEAD'], url: endpoint + '/tasks/:taskId/file', handler: async (request, reply) => {
        const { owner, taskId } = taskOwner(request), file = await jobs.acquire(owner, taskId);
        try {
            identify(request);
            reply.type('application/pdf').header('Accept-Ranges', 'bytes').header('ETag', file.etag).header('Content-Encoding', 'identity')
                .header('Content-Disposition', "inline; filename=document.pdf; filename*=UTF-8''" + encodeURIComponent(pdfFilename(file.inspection.title)));
            let start = 0, end = file.bytes - 1;
            const range = request.method === 'GET' && request.headers.range;
            if (range && (!request.headers['if-range'] || request.headers['if-range'] === file.etag)) {
                const match = /^bytes=(\d*)-(\d*)$/.exec(range);
                const invalid = () => { reply.header('Content-Range', 'bytes */' + file.bytes); throw new Fault(416, 'PDF 字节范围不合法'); };
                if (!match || (!match[1] && !match[2])) invalid();
                if (!match![1]) { const suffix = Number(match![2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) invalid(); start = Math.max(0, file.bytes - suffix); }
                else { start = Number(match![1]); end = match![2] ? Number(match![2]) : end; }
                if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= file.bytes || start > end) invalid();
                end = Math.min(end, file.bytes - 1);
                reply.code(206).header('Content-Range', `bytes ${start}-${end}/${file.bytes}`);
            }
            reply.header('Content-Length', end - start + 1);
            if (request.method === 'HEAD') { file.release(); return reply.send(); }
            return sendFile(file, reply, start, end);
        } catch (error) { file.release(); throw error; }
    } });
}
