import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createReadStream } from 'node:fs';
import { z } from 'zod';
import { actorFor, Fault, requireScope } from './auth.js';
import type { Service } from './service.js';
import { assetPath, exportDocumentImages, readableAsset, saveImage, validateImage } from './assets.js';
import { imageTypes, imageUploadLimit } from '../shared/assets.js';

export function registerAssetRoutes(app: FastifyInstance, service: Service) {
    let uploading = 0;
    const active = new WeakSet<FastifyRequest>();
    const releaseUpload = async (request: FastifyRequest) => { if (active.delete(request)) uploading--; };
    const parameters = z.object({ projectId: z.string().min(1).max(150), documentId: z.string().min(1).max(150).optional(), assetId: z.string().uuid().optional() });
    const actor = (request: FastifyRequest) => {
        const { projectId } = parameters.parse(request.params);
        const current = actorFor(service.store, request.headers.authorization?.replace(/^Bearer /, '') || request.cookies.session || '', !!request.headers.authorization, projectId);
        if (current.projectId !== projectId) throw new Fault(404, '项目不存在或无权访问');
        requireScope(current, 'workspace.read');
        return current;
    };
    app.addContentTypeParser(['application/octet-stream', ...imageTypes], { parseAs: 'buffer', bodyLimit: imageUploadLimit }, (_request, body, done) => done(null, body));
    app.post('/api/projects/:projectId/documents/:documentId/images', {
        bodyLimit: imageUploadLimit,
        onRequest: async request => {
            requireScope(actor(request), 'workspace.write');
            if (uploading >= 2) throw new Fault(429, '图片上传繁忙，请稍后重试');
            active.add(request);
            uploading++;
        },
        onResponse: releaseUpload,
        onRequestAbort: releaseUpload
    }, async request => {
        const { documentId } = parameters.parse(request.params);
        const input = z.object({ taskId: z.string().max(150).optional(), writeSessionId: z.string().uuid().optional() }).parse(request.query);
        const name = z.string().max(1500).parse(request.headers['x-file-name'] || 'image');
        let filename: string;
        try { filename = decodeURIComponent(name); } catch { throw new Fault(400, '图片文件名无效'); }
        const checkDocument = (current: ReturnType<typeof actor>) => {
            requireScope(current, 'workspace.write');
            const workspace = service.workspace(current);
            if (service.store.entity(workspace.head, documentId!)?.kind !== 'object') throw new Fault(404, '文档不存在');
        };
        checkDocument(actor(request));
        if (!Buffer.isBuffer(request.body)) throw new Fault(400, '请上传图片文件');
        const metadata = await validateImage(request.body);
        const current = actor(request);
        return service.execute(current, input, () => { checkDocument(current); return saveImage(service.store, current, request.body as Buffer, filename, metadata); });
    });
    app.get('/api/projects/:projectId/assets/:assetId', async (request, reply) => {
        const current = actor(request);
        const { assetId } = parameters.parse(request.params);
        const asset = readableAsset(service.store, current, assetId!);
        reply.type(asset.mime).header('Content-Disposition', 'inline; filename="image-' + asset.id + '.' + asset.extension + '"').header('Cross-Origin-Resource-Policy', 'same-origin').header('Content-Security-Policy', "default-src 'none'; sandbox");
        return reply.send(createReadStream(assetPath(service.store, asset)));
    });
    app.get('/api/projects/:projectId/documents/:documentId/export-images', async (request, reply) => {
        const { documentId } = parameters.parse(request.params);
        const archive = exportDocumentImages(service, actor(request), documentId!);
        return reply.type('application/zip').header('Content-Disposition', 'attachment; filename="document-with-images.zip"').send(archive);
    });
}
