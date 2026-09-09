import { test, expect } from '@playwright/test';
test('工具栏和命令面板在真实光标位置插入，不改写前文', async ({ page }) => {
    await page.goto('/'); await page.getByLabel('账号', { exact: true }).fill('designer'); await page.getByLabel('密码', { exact: true }).fill('e2e-password-123'); await page.getByRole('button', { name: '登录' }).click(); await expect(page.locator('.milkdown .editor')).toBeVisible();
    const response = await page.request.post('/api/workspace/operations', { headers: { 'x-workbench-client': 'test' }, data: { requestId: crypto.randomUUID(), operations: [{ type: 'put', expected: null, entity: { id: 'caret-test', kind: 'object', title: '光标定位测试', path: '验证/caret.md', fields: {}, collection: null, body: '第一段\n\n第二段' } }] } }); expect(response.ok()).toBeTruthy();
    await page.locator('.file-list').getByRole('button', { name: '光标定位测试', exact: true }).click();
    const editor = page.locator('.milkdown .editor'); await expect(editor).toContainText('第二段');
    await editor.locator('p').last().click(); await page.keyboard.press('End');
    await page.getByRole('toolbar').getByRole('button', { name: '链接', exact: true }).click(); await page.getByRole('combobox', { name: '搜索插入目标' }).fill('技能说明'); await page.keyboard.press('Enter');
    await expect(editor.locator('p').first()).toHaveText('第一段'); await expect(editor.locator('p').last()).toHaveText('第二段技能说明');
    await editor.locator('p').last().click(); await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.keyboard.press('Control+k');
    await page.getByRole('textbox', { name: '搜索命令与页面' }).fill('正文：嵌入文档'); await page.keyboard.press('Enter'); await page.getByRole('combobox', { name: '搜索插入目标' }).fill('技能说明'); await page.keyboard.press('Enter'); await expect(editor.locator('.document-embed')).toBeVisible();
    await page.keyboard.press('Control+s'); await expect(page.getByRole('status').filter({ hasText: '当前编辑已保存' })).toBeVisible();
    const closed = page.waitForResponse(response => response.url().endsWith('/workspace/presence') && response.request().postDataJSON()?.close === true); await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide'))); expect((await closed).ok()).toBeTruthy();
});
