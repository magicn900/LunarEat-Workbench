import { chromium, type Browser } from 'playwright';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pdfExportLimits, type PdfOptions } from '../shared/pdfExport.js';
import { escapeHtml } from './pdfDocument.js';
import { Fault } from './auth.js';
import { pdfImageOrigin, type PdfImageResources } from './pdfResources.js';

let mathStyles: string | null = null;
function katexStyles() {
    if (mathStyles !== null) return mathStyles;
    const require = createRequire(import.meta.url);
    const filename = require.resolve('katex/dist/katex.min.css');
    mathStyles = readFileSync(filename, 'utf8').replace(/url\(([^)]+)\)/g, (_match, source: string) => {
        const path = source.replace(/["']/g, '');
        if (!path.endsWith('.woff2')) return 'url()';
        return 'url(data:font/woff2;base64,' + readFileSync(join(dirname(filename), path)).toString('base64') + ')';
    });
    return mathStyles;
}

export async function renderPdf(html: string, options: PdfOptions, footer: string, signal: AbortSignal, resources?: PdfImageResources): Promise<Buffer> {
    let browser: Browser | null = null;
    const abort = () => { void browser?.close().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
        signal.throwIfAborted();
        try { browser = await chromium.launch({ headless: true, timeout: 20000 }); }
        catch { signal.throwIfAborted(); throw new Fault(503, 'PDF 生成器不可用，请安装 Chromium 浏览器运行依赖'); }
        signal.throwIfAborted();
        const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block' });
        await context.route('**/*', async route => {
            try {
                const request = route.request();
                const resource = !signal.aborted && request.method() === 'GET' && request.resourceType() === 'image' && new URL(request.url()).origin === pdfImageOrigin ? resources?.get(request.url()) : undefined;
                if (!signal.aborted && resource && ['image/png', 'image/jpeg', 'image/webp'].includes(resource.mime)) await route.fulfill({ status: 200, contentType: resource.mime, body: resource.bytes });
                else await route.abort();
            } catch { await route.abort().catch(() => {}); }
        });
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        const source = html.includes('class="katex') ? html.replace('</style>', '</style><style>' + katexStyles() + '</style>') : html;
        await page.setContent(source, { waitUntil: 'load' });
        const imagesReady = await page.evaluate(async () => {
            await document.fonts.ready;
            const loaded = await Promise.all([...document.images].map(async image => {
                try { await image.decode(); return image.naturalWidth > 0 && image.naturalHeight > 0; }
                catch { return false; }
            }));
            return loaded.every(Boolean);
        });
        signal.throwIfAborted();
        if (!imagesReady) throw new Fault(422, 'PDF 图片加载失败，请重试或检查附件');
        const footerTemplate = `<div style="font-family:Arial,'Microsoft YaHei','Noto Sans CJK SC',sans-serif;font-size:8px;color:#68775f;width:100%;padding:0 16mm;display:flex;justify-content:space-between;gap:12px"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:85%">${escapeHtml(footer)}</span>${options.pageNumbers ? '<span><span class="pageNumber"></span> / <span class="totalPages"></span></span>' : ''}</div>`;
        const bytes = await page.pdf({ format: options.paper, landscape: options.orientation === 'landscape', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate, tagged: true, outline: true });
        signal.throwIfAborted();
        if (bytes.length > pdfExportLimits.pdfBytes) throw new Fault(413, '生成的 PDF 超过 30 MB，请缩小导出范围');
        return bytes;
    } finally {
        signal.removeEventListener('abort', abort);
        await browser?.close().catch(() => {});
    }
}
