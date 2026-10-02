import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import type { Entity } from '../../src/shared/model';

type PdfBodyGate = { waiting: number; release: (index: number) => void; signals: (AbortSignal | null | undefined)[] };
async function login(page: Page) {
    await page.goto('/?project=demo&document=overview');
    await page.getByLabel('账号', { exact: true }).fill('designer');
    await page.getByLabel('密码', { exact: true }).fill('e2e-password-123');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('.milkdown .editor')).toBeVisible();
}
async function openExport(page: Page) {
    await page.getByRole('button', { name: '选择导出格式', exact: true }).click();
    await page.getByRole('menuitem', { name: '导出 PDF…', exact: true }).click();
    return page.getByRole('dialog', { name: '导出 PDF', exact: true });
}
test('真实预览、全部记录、布局覆盖、下载同一 PDF 和 Markdown 回归', async ({ page }) => {
    await login(page);
    const collectionId = crypto.randomUUID(), viewId = crypto.randomUUID(), documentId = crypto.randomUUID();
    const operations: { type: 'put'; expected: null; entity: Entity }[] = [
        { type: 'put', expected: null, entity: { id: collectionId, kind: 'collection', title: 'PDF技能库', path: 'PDF测试/' + collectionId + '.json', fields: [{ key: 'cost', label: '消耗', type: 'number', required: false }, { key: 'description', label: '说明', type: 'text', required: false }] } },
        { type: 'put', expected: null, entity: { id: viewId, kind: 'view', title: '技能速览', path: 'PDF测试/' + viewId + '.json', collection: collectionId, columns: ['title', 'cost', 'description'], layout: 'table', filter: null, sort: { key: 'cost', descending: false }, pagination: { pageSize: 10 } } },
        { type: 'put', expected: null, entity: { id: documentId, kind: 'object', title: 'PDF全部记录验证', path: 'PDF测试/' + documentId + '.md', collection: null, fields: {}, body: '# 全部记录\n\n:::view[' + viewId + ']' } },
    ];
    for (let index = 0; index < 15; index++) {
        const id = crypto.randomUUID();
        operations.push({ type: 'put', expected: null, entity: { id, kind: 'object', title: 'PDF技能 ' + index, path: 'PDF测试/' + id + '.md', collection: collectionId, fields: { cost: index, description: '分页验证' }, body: '记录正文不导出' } });
    }
    const mutation = await page.request.post('/api/workspace/operations', { headers: { 'x-workbench-client': 'test' }, data: { requestId: crypto.randomUUID(), operations } });
    expect(mutation.ok()).toBeTruthy();
    await page.goto('/?project=demo&document=' + documentId);
    await expect(page.getByLabel('页面标题')).toHaveValue('PDF全部记录验证');
    await expect(page.locator('.milkdown .editor')).toBeVisible();
    const recovery = page.getByRole('button', { name: '已检查，关闭副本', exact: true });
    if (await recovery.isVisible()) await recovery.click();
    const dialog = await openExport(page);
    await dialog.locator('.pdf-embedded-content summary').click();
    await expect(dialog.getByText('15 条匹配记录', { exact: false })).toBeVisible();
    const downloadButton = dialog.getByRole('button', { name: '下载 PDF', exact: true });
    await expect(downloadButton).toBeEnabled({ timeout: 30000 });
    await expect(dialog.locator('canvas')).toHaveAttribute('data-rendered', 'true');
    await expect(dialog.getByRole('link', { name: '放大预览', exact: true })).toHaveAttribute('href', /\/export-pdf\/tasks\/[^/]+\/file$/);
    await dialog.getByLabel('方向', { exact: true }).selectOption('landscape');
    await expect(downloadButton).toBeDisabled();
    await expect(downloadButton).toBeEnabled({ timeout: 30000 });
    await dialog.getByLabel('技能速览 导出方式').selectOption('link');
    await expect(downloadButton).toBeEnabled({ timeout: 30000 });
    await dialog.getByLabel('技能速览 导出方式').selectOption('original');
    await expect(downloadButton).toBeEnabled({ timeout: 30000 });
    await dialog.getByLabel('PDF 文件名').fill('导出效果验证');
    const downloading = page.waitForEvent('download');
    await downloadButton.click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe('导出效果验证.pdf');
    const downloaded = await readFile((await download.path())!);
    expect(downloaded.subarray(0, 5).toString()).toBe('%PDF-');
    const preview = await dialog.getByRole('link', { name: '放大预览', exact: true }).getAttribute('href');
    const previewBytes = await page.evaluate(async source => [...new Uint8Array(await (await fetch(source!)).arrayBuffer())], preview);
    expect(downloaded.equals(Buffer.from(previewBytes))).toBe(true);
    await page.screenshot({ path: 'test-results/pdf-export-desktop.png', fullPage: true });
    await dialog.getByRole('button', { name: '关闭', exact: true }).last().click();
    const markdownDownloading = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出', exact: true }).click();
    expect((await markdownDownloading).suggestedFilename()).toMatch(/\.md$/);
});
test('失败保留设置、取消中止请求、窄屏无溢出', async ({ page }) => {
    await login(page);
    await page.route('**/export-pdf/inspect', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '模拟预检失败' }) }));
    const dialog = await openExport(page);
    await dialog.getByLabel('PDF 文件名').fill('保留我的文件名');
    await expect(dialog.getByText('模拟预检失败')).toBeVisible();
    await expect(dialog.getByLabel('PDF 文件名')).toHaveValue('保留我的文件名');
    await page.unroute('**/export-pdf/inspect');
    await dialog.getByRole('button', { name: '重试生成', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '下载 PDF', exact: true })).toBeEnabled({ timeout: 30000 });
    await page.setViewportSize({ width: 390, height: 844 });
    const sizes = await dialog.evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth }));
    expect(sizes.content).toBeLessThanOrEqual(sizes.width);
    await page.screenshot({ path: 'test-results/pdf-export-mobile.png', fullPage: true });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/export-pdf/tasks', async route => { await gate; await route.abort().catch(() => {}); });
    await dialog.getByLabel('生成目录', { exact: true }).check();
    await expect(dialog.getByText('正在生成 PDF…', { exact: true }).first()).toBeVisible();
    await dialog.getByRole('button', { name: '取消生成', exact: true }).click();
    release();
    await expect(page.getByRole('dialog', { name: '导出 PDF', exact: true })).toHaveCount(0);
});

test('原图附件及重复引用保留像素尺寸，预览与下载使用同一份带图 PDF', async ({ page }) => {
    await login(page);
    const id = crypto.randomUUID();
    const entity = { id, kind: 'object', title: 'PDF原图验证', path: 'PDF测试/' + id + '.md', collection: null, fields: {}, body: '原图附件验证' };
    const headers = { 'x-workbench-client': 'test' };
    const created = await page.request.post('/api/workspace/operations', { headers, data: { requestId: crypto.randomUUID(), operations: [{ type: 'put', expected: null, entity }] } });
    expect(created.ok()).toBe(true);
    const image = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#317ca0' } }).png().toBuffer();
    const upload = await page.request.post('/api/projects/demo/documents/' + id + '/images', { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: image });
    expect(upload.ok()).toBe(true);
    const source = (await upload.json()).url;
    const body = `# 原图与重复附件\n\n![原图](${source})\n\n![重复](${source}?copy=1)`;
    const updated = await page.request.post('/api/workspace/operations', { headers, data: { requestId: crypto.randomUUID(), operations: [{ type: 'put', expected: entity, entity: { ...entity, body } }] } });
    expect(updated.ok()).toBe(true);
    await page.goto('/?project=demo&document=' + id);
    await expect(page.getByLabel('页面标题')).toHaveValue(entity.title);
    const dialog = await openExport(page);
    const button = dialog.getByRole('button', { name: '下载 PDF', exact: true });
    await expect(button).toBeEnabled({ timeout: 30000 });
    await expect(dialog.locator('canvas')).toHaveAttribute('data-rendered', 'true');
    const downloading = page.waitForEvent('download');
    await button.click();
    const downloaded = await readFile((await (await downloading).path())!);
    expect(/\/Subtype\s*\/Image\s*\/Width\s+1200\s*\/Height\s+800/.test(downloaded.toString('latin1'))).toBe(true);
    const preview = await dialog.getByRole('link', { name: '放大预览', exact: true }).getAttribute('href');
    const previewBytes = await page.evaluate(async source => [...new Uint8Array(await (await fetch(source!)).arrayBuffer())], preview);
    expect(downloaded.equals(Buffer.from(previewBytes))).toBe(true);
    await page.screenshot({ path: 'test-results/pdf-export-original-images.png', fullPage: true });
});

test('接收阶段可取消，旧响应不能覆盖新设置或重新打开的导出', async ({ page }) => {
    await page.addInitScript(() => {
        const releases: (() => void)[] = [];
        const state: PdfBodyGate = { waiting: 0, signals: [], release: index => releases[index]() };
        (window as unknown as { pdfBodyGate: PdfBodyGate }).pdfBodyGate = state;
        const original = window.fetch.bind(window);
        window.fetch = async (input, init) => {
            const response = await original(input, init);
            const source = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            if (/\/export-pdf\/tasks\/[^/]+\/file$/.test(source) && new Headers(init?.headers).get('x-workbench-client') === 'web' && response.ok) {
                const reader = response.body!.getReader(), read = reader.read.bind(reader);
                state.signals.push(init?.signal);
                const gate = new Promise<void>(resolve => releases.push(resolve)); state.waiting++;
                reader.read = async () => { await gate; return read(); };
                Object.defineProperty(response, 'body', { value: { getReader: () => reader } });
            }
            return response;
        };
    });
    await login(page);
    let dialog = await openExport(page);
    const waiting = () => page.evaluate(() => (window as unknown as { pdfBodyGate: PdfBodyGate }).pdfBodyGate.waiting);
    const button = () => dialog.getByRole('button', { name: '下载 PDF', exact: true });
    await expect(button()).toBeEnabled({ timeout: 30000 }); await button().click();
    await expect.poll(waiting).toBe(1);
    await expect(dialog.locator('.pdf-export-footer [role=status]')).toContainText('正在下载 PDF… 0%');
    await expect(button()).toBeDisabled();
    await dialog.getByLabel('纸张', { exact: true }).selectOption('Letter');
    await expect(button()).toBeEnabled({ timeout: 30000 }); await button().click();
    await expect.poll(waiting).toBe(2);
    await page.evaluate(() => (window as unknown as { pdfBodyGate: PdfBodyGate }).pdfBodyGate.release(0));
    await expect.poll(() => page.evaluate(() => (window as unknown as { pdfBodyGate: PdfBodyGate }).pdfBodyGate.signals[0]?.aborted)).toBe(true);
    await expect(dialog.locator('.pdf-export-footer [role=status]')).toContainText('正在下载 PDF… 0%');
    await expect(button()).toBeDisabled();
    await dialog.getByRole('button', { name: '关闭', exact: true }).last().click();
    await expect(dialog).toHaveCount(0);
    dialog = await openExport(page);
    await expect(dialog.getByText('上次导出', { exact: true })).toBeVisible();
    await expect(button()).toBeEnabled({ timeout: 30000 }); await button().click();
    await expect.poll(waiting).toBe(3);
    await page.evaluate(() => (window as unknown as { pdfBodyGate: PdfBodyGate }).pdfBodyGate.release(1));
    await expect(dialog.locator('.pdf-export-footer [role=status]')).toContainText('正在下载 PDF… 0%');
    await expect(button()).toBeDisabled();
    await page.screenshot({ path: 'test-results/pdf-export-receiving.png', fullPage: true });
    const downloading = page.waitForEvent('download');
    await page.evaluate(() => (window as unknown as { pdfBodyGate: PdfBodyGate }).pdfBodyGate.release(2));
    expect((await downloading).suggestedFilename()).toMatch(/\.pdf$/);
    await expect(button()).toBeEnabled();
    await expect(dialog.locator('canvas')).toHaveAttribute('data-rendered', 'true');
    await expect(dialog.getByLabel('纸张', { exact: true })).toHaveValue('Letter');
});

test('预览绘制失败仍可下载接收到的原文件', async ({ page }) => {
    const bytes = Buffer.from('%PDF-1.4\ninvalid preview');
    await page.route('**/export-pdf/tasks/*/file', route => route.fulfill({ status: 200, contentType: 'application/pdf', body: bytes }));
    await page.route('**/export-pdf/tasks/*', async route => { const response = await route.fetch(), status = await response.json(); if (status.state === 'ready') status.bytes = bytes.length; await route.fulfill({ response, json: status }); });
    await login(page);
    const dialog = await openExport(page);
    await expect(dialog.getByRole('alert')).toHaveText('预览渲染失败，可下载文件查看。');
    const button = dialog.getByRole('button', { name: '下载 PDF', exact: true });
    await expect(button).toBeEnabled();
    const downloading = page.waitForEvent('download');
    await button.click();
    const downloaded = await readFile((await (await downloading).path())!);
    expect(downloaded.equals(bytes)).toBe(true);
});

test('只复用最近结果，修改文件名或再次下载不重新生成', async ({ page }) => {
    await login(page);
    let creations = 0, downloads = 0;
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/export-pdf/tasks')) creations++; if (request.url().endsWith('/file') && request.headers()['x-workbench-client'] === 'web') downloads++; });
    let dialog = await openExport(page);
    await expect(dialog.getByRole('button', { name: '下载 PDF', exact: true })).toBeEnabled({ timeout: 30000 });
    const originalTime = await dialog.locator('.pdf-export-snapshot').textContent();
    await dialog.getByLabel('PDF 文件名').fill('第一次');
    let downloading = page.waitForEvent('download'); await dialog.getByRole('button', { name: '下载 PDF', exact: true }).click(); await downloading;
    await dialog.getByRole('button', { name: '关闭', exact: true }).last().click(); dialog = await openExport(page);
    await expect(dialog.getByText('上次导出', { exact: true })).toBeVisible();
    await expect(dialog.locator('.pdf-export-snapshot')).toHaveText(originalTime!);
    await dialog.getByLabel('PDF 文件名').fill('第二次');
    downloading = page.waitForEvent('download'); await dialog.getByRole('button', { name: '下载 PDF', exact: true }).click(); expect((await downloading).suggestedFilename()).toBe('第二次.pdf');
    expect(creations).toBe(1); expect(downloads).toBe(1);
    await dialog.getByRole('button', { name: '关闭', exact: true }).last().click();
    await page.getByLabel('页面标题').fill('内容变化使 PDF 缓存失效'); await page.getByLabel('页面标题').blur();
    dialog = await openExport(page); await expect(dialog.getByRole('button', { name: '下载 PDF', exact: true })).toBeEnabled({ timeout: 30000 });
    await expect(dialog.getByText('上次导出', { exact: true })).toHaveCount(0); expect(creations).toBe(2);
});

test('慢网络下多图大 PDF 首屏不等待完整下载', async ({ page, context }) => {
    test.setTimeout(120000); await login(page);
    const id = crypto.randomUUID(), headers = { 'x-workbench-client': 'test' };
    const entity = { id, kind: 'object', title: '分段预览慢网络验证', path: 'PDF测试/' + id + '.md', collection: null, fields: {}, body: 'Initial' };
    expect((await page.request.post('/api/workspace/operations', { headers, data: { requestId: crypto.randomUUID(), operations: [{ type: 'put', expected: null, entity }] } })).ok()).toBe(true);
    const sources: string[] = [];
    for (let index = 0; index < 9; index++) {
        const image = await sharp(randomBytes(640 * 480 * 3), { raw: { width: 640, height: 480, channels: 3 } }).png().toBuffer();
        const response = await page.request.post('/api/projects/demo/documents/' + id + '/images', { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: image });
        expect(response.ok()).toBe(true); sources.push((await response.json()).url);
    }
    const body = '# 首页先看文字\n\n' + '首页正文。后续页面保留所有原图，不降低画质。\n\n'.repeat(26) + sources.map((source, index) => `\n\n## 原图 ${index + 1}\n\n![原图](${source})`).join('');
    expect((await page.request.post('/api/workspace/operations', { headers, data: { requestId: crypto.randomUUID(), operations: [{ type: 'put', expected: entity, entity: { ...entity, body } }] } })).ok()).toBe(true);
    await page.goto('/?project=demo&document=' + id); await expect(page.getByLabel('页面标题')).toHaveValue(entity.title);
    await context.addCookies([{ name: 'pdf_slow', value: '1', url: 'http://127.0.0.1:14319' }]);
    const start = Date.now(), dialog = await openExport(page);
    await expect(dialog.locator('canvas')).toHaveAttribute('data-rendered', 'true', { timeout: 30000 });
    const elapsedMs = Date.now() - start;
    const file = await dialog.getByRole('link', { name: '放大预览', exact: true }).getAttribute('href');
    const status = await (await page.request.get(file!.replace(/\/file$/, ''))).json();
    const transfers = (await (await page.request.get('/__test/pdf-transfers')).json() as { url: string; range: string | null; sent: number; completed: boolean; total: number }[]).filter(transfer => transfer.url === file);
    expect(status.bytes).toBeGreaterThan(5 * 1048576);
    expect(transfers.some(transfer => !!transfer.range)).toBe(true);
    expect(transfers.filter(transfer => !transfer.range).every(transfer => !transfer.completed)).toBe(true);
    const received = transfers.reduce((sum, transfer) => sum + transfer.sent, 0);
    expect(received).toBeLessThan(status.bytes / 2); expect(elapsedMs).toBeLessThan(25000);
    console.log(JSON.stringify({ pdfRangePreview: { bytes: status.bytes, receivedAtFirstPage: received, firstPageMs: elapsedMs, transfers } }));
    await page.screenshot({ path: 'test-results/pdf-export-range-slow.png', fullPage: true });
    await dialog.getByRole('button', { name: '关闭', exact: true }).last().click();
});

test('正式界面不展示技术说明或首屏耗时，文件信息仍可读取', async ({ page }) => {
    await login(page);
    const dialog = await openExport(page);
    await expect(dialog.locator('canvas')).toHaveAttribute('data-rendered', 'true', { timeout: 30000 });
    await expect(dialog.getByText('按需载入当前页；点击下载时才接收完整文件。')).toHaveCount(0);
    await expect(dialog.getByText(/首屏.*秒/)).toHaveCount(0);
    await expect(dialog.locator('.pdf-export-metrics')).toHaveText(/^[\d.]+ MB$/);
    await expect(dialog.locator('.pdf-export-metrics')).toHaveAttribute('data-first-frame-ms', /^\d+$/);
    await expect(dialog.locator('.pdf-export-footer [role=status]')).toHaveText('已生成');
    await page.screenshot({ path: 'test-results/pdf-export-production-copy.png', fullPage: true });
});
