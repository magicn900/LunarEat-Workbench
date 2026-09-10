import { test, expect } from '@playwright/test';
for (const viewport of [{ width: 1920, height: 1080 }, { width: 390, height: 844 }]) {
    test('编辑栏固定在标题上方且正文独立滚动：' + viewport.width, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto('/'); await page.getByLabel('账号', { exact: true }).fill('designer'); await page.getByLabel('密码', { exact: true }).fill('e2e-password-123'); await page.getByRole('button', { name: '登录' }).click();
        await expect(page.locator('.milkdown .editor')).toBeVisible();
        const title = '工具栏定位验证 ' + viewport.width;
        const entity = { id: 'toolbar-layout-' + viewport.width, kind: 'object', title, path: '验证/toolbar-' + viewport.width + '.md', collection: null, fields: {}, body: Array.from({ length: 30 }, (_, index) => '验证段落 ' + (index + 1)).join('\n\n') };
        const created = await page.request.post('/api/workspace/operations', { headers: { 'x-workbench-client': 'test' }, data: { requestId: crypto.randomUUID(), operations: [{ type: 'put', expected: null, entity }] } }); expect(created.ok()).toBeTruthy();
        await page.keyboard.press('Control+k'); await page.getByRole('textbox', { name: '搜索命令与页面' }).fill(title); await page.getByRole('button', { name: '打开：' + title, exact: true }).click();
        const toolbar = page.getByRole('toolbar', { name: '正文编辑栏' });
        const editor = page.locator('.milkdown .editor'); await expect(editor).toContainText('验证段落 30');
        const toolbarBounds = (await toolbar.boundingBox())!;
        const revisionBounds = (await page.locator('.revision-bar').boundingBox())!;
        const sourceBounds = (await page.locator('.document-source-switch').boundingBox())!;
        expect(sourceBounds.y).toBeCloseTo(revisionBounds.y + revisionBounds.height, 0);
        expect(toolbarBounds.y).toBeCloseTo(sourceBounds.y + sourceBounds.height, 0);
        const heading = page.locator('.page-heading'); const headingTop = (await heading.boundingBox())!.y;
        expect(headingTop).toBeGreaterThanOrEqual(toolbarBounds.y + toolbarBounds.height);
        const inspector = page.locator('.inspector');
        if (await inspector.isVisible()) expect(toolbarBounds.x + toolbarBounds.width).toBeLessThanOrEqual((await inspector.boundingBox())!.x);
        await page.screenshot({ path: 'test-results/toolbar-top-' + viewport.width + '.png', fullPage: true });
        const scroll = page.locator('.document-scroll'); await scroll.evaluate(element => { element.scrollTop = 300; });
        await expect.poll(async () => (await heading.boundingBox())!.y).toBeLessThan(headingTop - 200);
        expect((await toolbar.boundingBox())!.y).toBeCloseTo(toolbarBounds.y, 0);
        await page.screenshot({ path: 'test-results/toolbar-scrolled-' + viewport.width + '.png', fullPage: true });
        await editor.locator('p').last().click(); await page.keyboard.press('End');
        await toolbar.getByRole('button', { name: '链接', exact: true }).click(); await page.getByRole('combobox', { name: '搜索插入目标' }).fill('技能说明'); await page.keyboard.press('Enter');
        await expect(editor.locator('p').last()).toHaveText('验证段落 30技能说明');
        expect((await toolbar.boundingBox())!.y).toBeCloseTo(toolbarBounds.y, 0);
        await toolbar.getByRole('button', { name: '撤销正文修改', exact: true }).click(); await expect(editor.locator('p').last()).toHaveText('验证段落 30');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && scrollY === 0)).toBe(true);
        await page.keyboard.press('Control+s'); await expect(page.getByRole('status').filter({ hasText: '当前编辑已保存' })).toBeVisible();
        const closed = page.waitForResponse(response => response.url().endsWith('/workspace/presence') && response.request().postDataJSON()?.close === true);
        await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
        const response = await closed; expect(response.ok()).toBeTruthy(); expect(response.request().postDataJSON().dirty).toBe(false);
    });
}
