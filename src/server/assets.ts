import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { zipSync, strToU8 } from 'fflate';
import { Transform } from '@milkdown/prose/transform';
import type { Store } from './store.js';
import type { Service } from './service.js';
import type { Codec } from './codec.js';
import { Fault, requireScope } from './auth.js';
import { serialize, type Actor, type Tree } from '../shared/model.js';
import { assetReference, assetURL, imagePixelLimit, imageUploadLimit } from '../shared/assets.js';

type Asset = { id: string; project_id: string; user_id: string; hash: string; mime: string; extension: string; name: string; size: number; width: number; height: number; published: number };
export function assetPath(store: Store, asset: Pick<Asset, 'project_id' | 'hash'>) { return join(store.root, 'attachments', store.hash(asset.project_id), asset.hash); }
export function readableAsset(store: Store, actor: Actor, id: string): Asset {
    requireScope(actor, 'workspace.read');
    const asset = store.db.prepare('SELECT * FROM image_assets WHERE id=? AND project_id=?').get(id, actor.projectId) as Asset | undefined;
    if (!asset || asset.user_id !== actor.userId && !asset.published) throw new Fault(404, '图片不存在或无权访问');
    return asset;
}
export async function validateImage(buffer: Buffer) {
    if (!buffer.length || buffer.length > imageUploadLimit) throw new Fault(413, '图片不能超过 10 MB');
    try {
        const image = sharp(buffer, { limitInputPixels: imagePixelLimit, failOn: 'warning' });
        const metadata = await image.metadata();
        if (!metadata.width || !metadata.height || !['png', 'jpeg', 'webp'].includes(metadata.format) || (metadata.pages || 1) !== 1) throw new Error('format');
        await image.stats();
        return { mime: 'image/' + metadata.format, extension: metadata.format === 'jpeg' ? 'jpg' : metadata.format, width: metadata.width, height: metadata.height };
    } catch { throw new Fault(400, '请选择有效的静态 PNG、JPEG 或 WebP 图片，最多 4000 万像素'); }
}
export function saveImage(store: Store, actor: Actor, buffer: Buffer, name: string, metadata: Awaited<ReturnType<typeof validateImage>>) {
    const hash = createHash('sha256').update(buffer).digest('hex');
    const prior = store.db.prepare('SELECT id FROM image_assets WHERE project_id=? AND user_id=? AND hash=?').get(actor.projectId, actor.userId, hash) as { id: string } | undefined;
    if (prior) return { id: prior.id, url: assetURL(actor.projectId, prior.id), ...metadata, size: buffer.length };
    const directory = join(store.root, 'attachments', store.hash(actor.projectId));
    mkdirSync(directory, { recursive: true });
    const destination = join(directory, hash);
    if (!existsSync(destination)) {
        const temporary = destination + '.' + randomUUID();
        const file = openSync(temporary, 'wx');
        try { writeFileSync(file, buffer); fsyncSync(file); } finally { closeSync(file); }
        renameSync(temporary, destination);
    }
    const id = randomUUID();
    store.db.prepare('INSERT INTO image_assets(id,project_id,user_id,hash,mime,extension,name,size,width,height,published,created) VALUES (?,?,?,?,?,?,?,?,?,?,0,?)').run(id, actor.projectId, actor.userId, hash, metadata.mime, metadata.extension, name.slice(0, 255), buffer.length, metadata.width, metadata.height, new Date().toISOString());
    return { id, url: assetURL(actor.projectId, id), ...metadata, size: buffer.length };
}
export function referencedAssets(codec: Codec, tree: Tree) {
    const assets = new Map<string, { id: string; projectId: string }>();
    for (const entity of Object.values(tree)) if (entity.kind === 'object' && entity.body.includes('/assets/')) {
        codec.parse(entity.body).descendants(node => {
            if (node.type.name !== 'image') return;
            const reference = assetReference(node.attrs.src);
            if (reference) assets.set(reference.projectId + ':' + reference.id, reference);
        });
    }
    return [...assets.values()];
}
export function checkPublicationAssets(store: Store, codec: Codec, actor: Actor, tree: Tree) {
    for (const reference of referencedAssets(codec, tree)) {
        if (reference.projectId !== actor.projectId) throw new Fault(409, '文档包含其他项目的图片，请在当前项目重新上传');
        readableAsset(store, actor, reference.id);
    }
}
export function publishAssets(store: Store, codec: Codec, projectId: string, tree: Tree) {
    for (const reference of referencedAssets(codec, tree)) if (reference.projectId === projectId) store.db.prepare('UPDATE image_assets SET published=1 WHERE id=? AND project_id=?').run(reference.id, projectId);
}
export function exportDocumentImages(service: Service, actor: Actor, documentId: string) {
    requireScope(actor, 'workspace.read');
    const entity = service.store.entity(service.workspace(actor).head, documentId);
    if (entity?.kind !== 'object') throw new Fault(404, '文档不存在');
    const transform = new Transform(service.codec.parse(entity.body));
    const files: Record<string, Uint8Array> = {};
    let size = 0;
    transform.doc.descendants((node, position) => {
        if (node.type.name !== 'image') return;
        const reference = assetReference(node.attrs.src);
        if (!reference) return;
        if (reference.projectId !== actor.projectId) throw new Fault(409, '请先将跨项目图片上传到当前项目');
        const asset = readableAsset(service.store, actor, reference.id);
        const filename = 'images/' + asset.id + '.' + asset.extension;
        if (!files[filename]) {
            size += asset.size;
            if (size > 50 * 1024 * 1024) throw new Fault(413, '单次图片导出不能超过 50 MB');
            files[filename] = readFileSync(assetPath(service.store, asset));
        }
        transform.setNodeMarkup(position, undefined, { ...node.attrs, src: filename });
    });
    files['document.md'] = strToU8(serialize({ ...entity, body: service.codec.serialize(transform.doc) }));
    return Buffer.from(zipSync(files, { level: 0 }));
}
