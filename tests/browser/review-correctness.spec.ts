import { test, expect } from '@playwright/test';
const headers = { 'x-workbench-client': 'test', 'x-project-id': 'demo' };
test.beforeEach(async ({ page }) => {
    expect((await page.request.post('/api/login', { headers, data: { username: 'designer', password: 'e2e-password-123' } })).ok()).toBe(true);
    await page.goto('/');
    await expect(page.getByLabel('霜刃 说明').first()).toBeVisible();
});
test('另一个标签页改选项目不会改变当前页面的保存目标', async ({ page, context }) => {
    const other = await context.newPage();
    await other.goto('/');
    await other.evaluate(() => localStorage.setItem('workbench-project', 'another-project'));
    const saved = page.waitForRequest(request => request.url().endsWith('/api/workspace/operations'));
    const input = page.getByLabel('霜刃 说明').first();
    await input.fill('本页面仍写入自己的项目'); await input.press('Tab');
    expect((await saved).headers()['x-project-id']).toBe('demo');
    await expect.poll(async () => (await (await page.request.get('/api/workspace', { headers })).json()).tree.frost.fields.description).toBe('本页面仍写入自己的项目');
    await other.close();
});
test('延迟保存响应期间继续输入，最终页面和服务器都保留最后输入', async ({ page }) => {
    let release!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    await page.route('**/api/workspace/operations', async route => {
        if (!first) { await route.continue(); return; }
        first = false;
        const response = await route.fetch();
        await delayed;
        await route.fulfill({ response });
    });
    const input = page.getByLabel('霜刃 说明').first();
    try {
        await input.fill('first'); await input.press('Tab');
        await expect.poll(() => first).toBe(false);
        await input.fill('second'); await input.press('Tab');
        release();
        await expect.poll(async () => (await (await page.request.get('/api/workspace', { headers })).json()).tree.frost.fields.description).toBe('second');
        await expect(input).toHaveValue('second');
    } finally { release(); }
});
test('失联页面保护有可发现且需要确认的恢复入口', async ({ page }) => {
    const clientId = crypto.randomUUID();
    expect((await page.request.post('/api/workspace/presence', { headers, data: { clientId, dirty: true } })).ok()).toBe(true);
    const banner = page.locator('.control-banner').filter({ hasText: clientId.slice(0,8) });
    const button = banner.getByRole('button', { name: '确认放弃此页面的未保存输入保护' });
    await expect(button).toBeVisible({ timeout: 45000 });
    page.once('dialog', dialog => dialog.dismiss()); await button.click(); await expect(button).toBeVisible();
    page.once('dialog', dialog => dialog.accept()); await button.click(); await expect(banner).toHaveCount(0);
});

