import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
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
    const snapshot = await (await page.request.get('/api/workspace')).json();
    const view = snapshot.tree['skills-table'];
    const operations = [{ type: 'put', expected: view, entity: { ...view, pagination: { pageSize: 10 } } }];
    for (let index = 0; index < 12; index++) {
        const id = 'pdf-browser-' + index;
        if (!snapshot.tree[id]) operations.push({ type: 'put', expected: null as any, entity: { id, kind: 'object', title: 'PDF技能 ' + index, path: 'PDF测试/' + id + '.md', collection: 'skills', fields: { cost: index, description: '分页验证' }, body: '记录正文不导出' } });
    }
    const mutation = await page.request.post('/api/workspace/operations', { headers: { 'x-workbench-client': 'test' }, data: { requestId: crypto.randomUUID(), operations } });
    expect(mutation.ok()).toBeTruthy();
    await page.reload();
    await expect(page.locator('.milkdown .editor')).toBeVisible();
    const recovery = page.getByRole('button', { name: '已检查，关闭副本', exact: true });
    if (await recovery.isVisible()) await recovery.click();
    const dialog = await openExport(page);
    await dialog.locator('.pdf-embedded-content summary').click();
    await expect(dialog.getByText('15 条匹配记录', { exact: false })).toBeVisible();
    const downloadButton = dialog.getByRole('button', { name: '下载 PDF', exact: true });
    await expect(downloadButton).toBeEnabled({ timeout: 30000 });
    await expect(dialog.locator('canvas')).toHaveAttribute('data-rendered', 'true');
    await expect(dialog.getByRole('link', { name: '放大预览', exact: true })).toHaveAttribute('href', /^blob:/);
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
    await page.route('**/export-pdf', async route => { await gate; await route.abort().catch(() => {}); });
    await dialog.getByLabel('生成目录', { exact: true }).check();
    await expect(dialog.getByText('正在生成 PDF 预览…', { exact: true }).first()).toBeVisible();
    await dialog.getByRole('button', { name: '取消生成', exact: true }).click();
    release();
    await expect(page.getByRole('dialog', { name: '导出 PDF', exact: true })).toHaveCount(0);
});
