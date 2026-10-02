import { beforeAll, expect, it } from 'vitest';
import { createServer } from 'node:http';
import sharp from 'sharp';
import { renderPdf } from '../src/server/pdfRenderer';
import { pdfOptionsSchema } from '../src/shared/pdfExport';

const origin = 'https://pdf-images.invalid';
const source = origin + '/job-one/image';
const options = pdfOptionsSchema.parse({});
const html = (image: string) => `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${origin}"></head><body><img src="${image}" style="width:200px"></body></html>`;
let image: Buffer;
beforeAll(async () => { image = await sharp({ create: { width: 1200, height: 800, channels: 4, background: '#376548' } }).png().toBuffer(); });

it('仅通过本任务资源生成图片 PDF，原始像素尺寸不变', async () => {
    const bytes = await renderPdf(html(source), options, 'snapshot', AbortSignal.timeout(15000), new Map([[source, { mime: 'image/png', bytes: image }]]));
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(/\/Subtype\s*\/Image\s*\/Width\s+1200\s*\/Height\s+800/.test(bytes.toString('latin1'))).toBe(true);
});
it.each(['jpeg', 'webp'] as const)('%s 原图也能通过任务资源加载', async format => {
    const bytes = await sharp(image).toFormat(format).toBuffer();
    const pdf = await renderPdf(html(source), options, 'snapshot', AbortSignal.timeout(15000), new Map([[source, { mime: 'image/' + format, bytes }]]));
    expect(/\/Width\s+1200\s*\/Height\s+800/.test(pdf.toString('latin1'))).toBe(true);
});
it('保留直接调用生成器时的合法 data URI 图片支持', async () => {
    const pdf = await renderPdf(`<html><body><img src="data:image/png;base64,${image.toString('base64')}" style="width:200px"></body></html>`, options, 'snapshot', AbortSignal.timeout(15000));
    expect(/\/Width\s+1200\s*\/Height\s+800/.test(pdf.toString('latin1'))).toBe(true);
});
it('缺失或其他任务的图片资源不能静默丢失', async () => {
    const resources = new Map([[source, { mime: 'image/png', bytes: image }]]);
    await expect(renderPdf(html(origin + '/job-two/image'), options, 'snapshot', AbortSignal.timeout(15000), resources)).rejects.toThrow('图片');
});
it('图片资源字节损坏时明确失败，不返回缺图的 PDF', async () => {
    await expect(renderPdf(html(source), options, 'snapshot', AbortSignal.timeout(15000), new Map([[source, { mime: 'image/png', bytes: Buffer.from('corrupted') }]]))).rejects.toThrow('图片');
});
it('资源映射也不能放开外网、非图片资源或文档脚本', async () => {
    let received = 0;
    const server = createServer((_request, response) => { received++; response.end(image); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('fixture');
    const external = 'http://127.0.0.1:' + address.port + '/private';
    try {
        await expect(renderPdf(`<html><body><script>fetch('${external}')</script><img src="${external}"></body></html>`, options, 'snapshot', AbortSignal.timeout(15000), new Map([[external, { mime: 'image/png', bytes: image }]]))).rejects.toThrow('图片');
        expect(received).toBe(0);
        await expect(renderPdf(html(source), options, 'snapshot', AbortSignal.timeout(15000), new Map([[source, { mime: 'text/html', bytes: image }]]))).rejects.toThrow('图片');
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
it('图片请求中止后仍能生成下一份 PDF', async () => {
    const controller = new AbortController();
    const resources = new Map([[source, { mime: 'image/png', bytes: image }]]);
    const get = resources.get.bind(resources);
    resources.get = key => { const value = get(key); controller.abort(); return value; };
    await expect(renderPdf(html(source), options, 'snapshot', controller.signal, resources)).rejects.toThrow();
    const bytes = await renderPdf(html(source), options, 'snapshot', AbortSignal.timeout(15000), new Map([[source, { mime: 'image/png', bytes: image }]]));
    expect(/\/Width\s+1200\s*\/Height\s+800/.test(bytes.toString('latin1'))).toBe(true);
});
