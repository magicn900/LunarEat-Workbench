import type { FastifyInstance } from 'fastify';
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { actorFor, Fault, requireScope } from './auth.js';
import { projectState } from './projectState.js';
import { readableAsset, assetPath } from './assets.js';
import { assetReference } from '../shared/assets.js';
import { pdfRequestSchema, pdfExportLimits, pdfFilename, pdfSnapshotDate, type PdfRequest } from '../shared/pdfExport.js';
import { preparePdfDocument, type PdfContext, type PdfImage } from './pdfDocument.js';
import { renderPdf } from './pdfRenderer.js';
import type { Service } from './service.js';
import type { Actor } from '../shared/model.js';

export function registerPdfRoutes(app: FastifyInstance, service: Service) {
    let active = 0;
    const parameters = z.object({ projectId: z.string().min(1).max(150), documentId: z.string().min(1).max(150) });
    const identify = (request: { params: unknown; headers: Record<string, any>; cookies: Record<string, string | undefined> }) => {
        const { projectId, documentId } = parameters.parse(request.params);
        const actor = actorFor(service.store, request.headers.authorization?.replace(/^Bearer /, '') || request.cookies.session || '', !!request.headers.authorization, projectId);
        if (actor.projectId !== projectId) throw new Fault(404, '项目不存在或无权访问');
        requireScope(actor, 'workspace.read');
        return { actor, projectId, documentId };
    };
    const prepare = async (actor: Actor, documentId: string, input: PdfRequest, origin: string, signal: AbortSignal, images: boolean) => {
        signal.throwIfAborted();
        const workspace = service.workspace(actor);
        if (workspace.head !== input.head) throw new Fault(409, '文档或集合已变化，请刷新导出快照');
        const tree = service.store.tree(workspace.head);
        const revision = service.store.db.prepare('SELECT id FROM revisions WHERE project_id=? AND tree=? ORDER BY created DESC LIMIT 1').get(actor.projectId, workspace.head) as { id: string } | undefined;
        const source = revision ? (input.options.language === 'en' ? 'Published version ' : '正式版本 ') + revision.id.slice(0, 12) : input.options.language === 'en' ? 'Personal draft' : '个人草稿';
        const context: PdfContext = { head: workspace.head, at: input.at || new Date().toISOString(), timeZone: input.timeZone, project: projectState(service.store, actor.projectId), origin, source, signal, inspectionOnly: !images };
        let imageBytes = 0;
        const cache = new Map<string, Promise<PdfImage>>();
        const resolve = (source: string) => {
            const cached = cache.get(source);
            if (cached) return cached;
            const image = (async (): Promise<PdfImage> => {
                const reference = assetReference(source);
                let sameOrigin = false;
                try { sameOrigin = new URL(source, origin).origin === origin; } catch {}
                if (!reference || !sameOrigin) return { error: input.options.language === 'en' ? 'External images are not fetched automatically' : '外部图片不自动下载' };
                if (reference.projectId !== actor.projectId) return { error: input.options.language === 'en' ? 'Image unavailable' : '图片不存在或无权访问' };
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
                try { const bytes = await readFile(filename, { signal }); if (bytes.length !== size) throw Error('changed'); return { source: 'data:' + asset.mime + ';base64,' + bytes.toString('base64') }; }
                catch { signal.throwIfAborted(); return { error: input.options.language === 'en' ? 'Image file missing or changed' : '图片文件缺失或已变化' }; }
            })();
            cache.set(source, image);
            return image;
        };
        return preparePdfDocument(tree, documentId, context, input.options, resolve);
    };
    const endpoint = '/api/projects/:projectId/documents/:documentId/export-pdf';
    for (const inspection of [true, false]) app.post(endpoint + (inspection ? '/inspect' : ''), async (request, reply) => {
        const { actor, documentId } = identify(request);
        const input = pdfRequestSchema.parse(request.body);
        if (active >= 2) throw new Fault(429, 'PDF 导出繁忙，请稍后重试');
        active++;
        const controller = new AbortController();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(pdfExportLimits.timeoutMs)]);
        const abort = () => controller.abort();
        reply.raw.once('close', abort);
        request.raw.once('aborted', abort);
        try {
            const origin = new URL(process.env.WORKBENCH_ORIGIN || request.protocol + '://' + request.headers.host).origin;
            const prepared = await prepare(actor, documentId, input, origin, signal, !inspection);
            if (inspection) return prepared.inspection;
            if (prepared.inspection.warnings.length && !input.options.allowIncomplete) throw new Fault(422, '导出包含不可用内容，请确认后带缺失标记继续', { warnings: prepared.inspection.warnings });
            const bytes = await renderPdf(prepared.html, input.options, prepared.inspection.source + ' · ' + pdfSnapshotDate(prepared.inspection.at, input.timeZone), signal);
            identify(request);
            return reply.type('application/pdf').header('Content-Disposition', "inline; filename=document.pdf; filename*=UTF-8''" + encodeURIComponent(pdfFilename(prepared.inspection.title))).send(bytes);
        } catch (error) {
            if (controller.signal.aborted) return reply;
            if (signal.aborted) return reply.code(504).send({ error: 'PDF 生成超时，请缩小导出范围后重试', requestId: request.id });
            if (error instanceof Fault && error.status === 503) return reply.code(503).send({ error: error.message, requestId: request.id });
            throw error;
        } finally {
            active--;
            reply.raw.removeListener('close', abort);
            request.raw.removeListener('aborted', abort);
        }
    });
}
