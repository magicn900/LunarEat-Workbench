import { expect, test, type Page } from '@playwright/test';
const headers = { 'x-workbench-client': 'test' };
async function setup(page: Page, body: string) {
    expect((await page.request.post('/api/login', { headers, data: { username: 'designer', password: 'e2e-password-123' } })).ok()).toBe(true);
    const identity = await (await page.request.get('/api/identity')).json();
    await page.request.post('/api/account/preferences', { headers, data: { ...identity.preferences, language: 'zh-CN', shortcuts: {} } });
    await page.goto('/'); await expect(page.locator('.milkdown .editor')).toBeVisible();
    const id = crypto.randomUUID();
    const entity = { id, kind: 'object', title: id, path: '性能测试/' + id + '.md', collection: null, fields: {}, body };
    expect((await page.request.post('/api/workspace/operations', { headers, data: { requestId: crypto.randomUUID(), operations: [{ type: 'put', expected: null, entity }] } })).ok()).toBe(true);
    await page.keyboard.press('Control+k'); await page.getByRole('textbox', { name: '搜索命令与页面' }).fill(id);
    await page.getByRole('button', { name: '打开：' + id, exact: true }).click();
    await expect(page.getByLabel('页面标题')).toHaveValue(id); await expect(page.locator('.milkdown .editor')).toBeVisible();
    return id;
}
async function backup(page: Page, id: string) {
    return page.evaluate(id => Object.keys(localStorage).filter(key => key.startsWith('draft:') && key.endsWith(':' + id)).map(key => localStorage.getItem(key)).join(''), id);
}
test('长文档移动光标不写恢复副本，未确认输入在 pagehide 时立即保存', async ({ page }) => {
    const id = await setup(page, Array.from({ length: 500 }, (_, index) => 'Paragraph ' + index + ': ordinary design text with **emphasis**, numbers and a short description.').join('\n\n'));
    await page.evaluate(() => {
        const original = Storage.prototype.setItem;
        (window as any).backupWrites = 0;
        Storage.prototype.setItem = function(key, value) { if (key.startsWith('draft:')) (window as any).backupWrites++; original.call(this, key, value); };
    });
    const editor = page.locator('.milkdown .editor'); await editor.click(); await page.keyboard.press('Control+End');
    for (let index = 0; index < 20; index++) await page.keyboard.press(index % 2 ? 'ArrowRight' : 'ArrowLeft');
    expect(await page.evaluate(() => (window as any).backupWrites)).toBe(0);
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/documents/' + id + '/steps', async route => { await gate; await route.continue(); });
    try {
        await page.keyboard.insertText('LATEST-UNCONFIRMED');
        await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
        expect(await backup(page, id)).toContain('LATEST-UNCONFIRMED');
    } finally { release(); }
    await expect.poll(() => backup(page, id)).toBe('');
    await page.reload(); await expect(page.locator('.milkdown .editor')).toContainText('LATEST-UNCONFIRMED');
    await expect(page.locator('.recovery')).toHaveCount(0);
});
test('同步失败立刻补齐最新输入，源码降级的恢复副本完整保留', async ({ page }) => {
    const id = await setup(page, 'original');
    await page.route('**/api/documents/' + id + '/steps', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '测试同步故障', requestId: 'performance-recovery' }) }));
    await page.locator('.milkdown .editor').click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('FAILURE-RECOVERY');
    await expect(page.getByRole('textbox', { name: '富文本恢复副本' })).toHaveValue(/FAILURE-RECOVERY/);
    await expect(page.getByRole('textbox', { name: 'Markdown 源码', exact: true })).toBeEnabled();
    expect(await backup(page, id)).toContain('FAILURE-RECOVERY');
});
test('公式切换只展开当前预览，滚动定位按帧合并', async ({ page }) => {
    await setup(page, Array.from({ length: 100 }, () => '$x+y$').join('\n\n'));
    const formulas = page.locator('.milkdown .editor [data-math]');
    await expect(formulas).toHaveCount(100);
    await formulas.first().locator('.math-rendered').click(); await expect(page.locator('.math-preview .katex')).toBeVisible();
    await formulas.nth(1).locator('.math-rendered').click(); await expect(formulas.nth(1)).toHaveClass(/math-editing/);
    await expect(formulas.first()).not.toHaveClass(/math-editing/); await expect(page.locator('.math-preview')).toHaveCount(1);
    const reads = await page.evaluate(async () => {
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const node = document.querySelector<HTMLElement>('.math-editing')!;
        const original = node.getBoundingClientRect.bind(node); let count = 0;
        node.getBoundingClientRect = () => { count++; return original(); };
        for (let index = 0; index < 30; index++) window.dispatchEvent(new Event('scroll'));
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); node.getBoundingClientRect = original; return count;
    });
    expect(reads).toBe(1);
    await page.keyboard.press('Escape'); await expect(page.locator('.math-preview')).toHaveCount(0);
});
