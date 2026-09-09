import { test, expect, type Page } from '@playwright/test';
const headers = { 'x-workbench-client': 'test' };
async function login(page: Page, username = 'designer') { await page.goto('/'); await page.getByLabel('账号', { exact: true }).fill(username); await page.getByLabel('密码', { exact: true }).fill('e2e-password-123'); await page.getByRole('button', { name: '登录' }).click(); await expect(page.locator('.milkdown .editor')).toBeVisible(); }
test('发布记录按实现进度浏览，确认与重新标记可取消，策划只读状态，窄屏列表详情切换', async ({ page, browser }) => {
    await login(page);
    const snapshot = (await (await page.request.get('/api/workspace')).json()).tree;
    const entity = { id: 'release-navigation-example', kind: 'object', title: '发布导航验证', path: '验证/发布导航.md', body: '仅用于发布记录交互验证。', collection: null, fields: {} };
    expect((await page.request.post('/api/workspace/operations', { headers, data: { requestId: crypto.randomUUID(), operations: [{ type: 'put', entity, expected: snapshot[entity.id] || null }] } })).ok()).toBe(true);
    const preview = await (await page.request.get('/api/publish/preview')).json();
    expect((await page.request.post('/api/publish', { headers, data: { requestId: crypto.randomUUID(), head: preview.head, main: preview.main, title: '发布记录交互验证', description: '检查列表、实现进度与窄屏阅读；不是实际游戏代码同步。' } })).ok()).toBe(true);
    await page.getByRole('button', { name: '发布记录', exact: true }).click();
    await expect(page.getByRole('button', { name: '批量确认', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '确认已同步至实现', exact: true })).toHaveCount(0);
    await page.getByLabel('搜索发布记录').fill('不存在的发布标题'); await expect(page.getByText('没有符合条件的发布记录')).toBeVisible();
    await page.getByLabel('搜索发布记录').fill('发布记录交互验证'); await expect(page.getByRole('heading', { name: '发布记录交互验证', exact: true })).toBeVisible();
    await expect(page.locator('.review-detail')).toContainText('正文：'); await expect(page.locator('.review-detail')).not.toContainText('"kind":');
    await page.screenshot({ path: 'test-results/release-history-desktop.png', fullPage: true });
    const context = await browser.newContext(); const programmer = await context.newPage();
    try {
        await login(programmer, 'developer'); await programmer.getByRole('button', { name: '发布记录', exact: true }).click();
        await programmer.getByRole('button', { name: '确认已同步至实现', exact: true }).click();
        const dialog = programmer.getByRole('dialog', { name: '确认已同步至实现', exact: true });
        await dialog.getByLabel('代码仓库标识').fill('demo://not-verified'); await programmer.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
        await expect(programmer.getByRole('button', { name: '确认已同步至实现', exact: true })).toBeVisible();
        await programmer.getByRole('button', { name: '确认已同步至实现', exact: true }).click();
        await dialog.getByLabel('代码仓库标识').fill('demo://not-verified'); await dialog.getByLabel('实现版本（代码 commit）').fill('test-only'); await dialog.getByLabel('确认说明').fill('演示验证，未检查真实代码。');
        await dialog.getByRole('button', { name: '将 1 条记录确认为已同步至实现' }).click(); await expect(dialog).toHaveCount(0);
        await expect(page.locator('.implementation-record')).toContainText('已确认同步至实现');
        await page.getByRole('group', { name: '按实现进度筛选' }).getByRole('button', { name: /^待同步至实现/ }).click(); await expect(page.getByText('没有符合条件的发布记录')).toBeVisible();
        await page.getByRole('group', { name: '按实现进度筛选' }).getByRole('button', { name: /^已确认同步至实现/ }).click(); await expect(page.getByRole('heading', { name: '发布记录交互验证', exact: true })).toBeVisible();
        await programmer.getByRole('button', { name: '重新标记为待同步至实现', exact: true }).click(); await programmer.keyboard.press('Escape');
        await expect(programmer.getByRole('button', { name: '重新标记为待同步至实现', exact: true })).toBeVisible();
        await programmer.getByRole('button', { name: '重新标记为待同步至实现', exact: true }).click();
        await programmer.getByLabel('重新标记的原因').fill('继续核对实现。'); await programmer.getByRole('button', { name: '确认重新标记', exact: true }).click();
        await expect(programmer.getByRole('button', { name: '确认已同步至实现', exact: true })).toBeVisible();
    } finally { await context.close(); }
    await page.getByRole('group', { name: '按实现进度筛选' }).getByRole('button', { name: /^待同步至实现/ }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    const list = page.getByRole('navigation', { name: '发布记录列表' }); await expect(list).toBeVisible();
    await list.getByRole('button').filter({ hasText: '发布记录交互验证' }).click(); await expect(list).toBeHidden();
    await expect(page.getByRole('heading', { name: '发布记录交互验证', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/release-history-mobile.png', fullPage: true });
    await page.getByRole('button', { name: '返回发布列表', exact: true }).click(); await expect(list).toBeVisible();
});
