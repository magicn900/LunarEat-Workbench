import { test, expect, type Page } from '@playwright/test';
async function login(page: Page) { await page.goto('/'); await page.getByLabel('账号', { exact: true }).fill('designer'); await page.getByLabel('密码', { exact: true }).fill('e2e-password-123'); await page.getByRole('button', { name: '登录' }).click(); await expect(page.locator('.milkdown .editor')).toBeVisible(); }
async function openDocument(page: Page) { await page.locator('.file-list').getByRole('button', { name: '编辑功能验证', exact: true }).click(); await expect(page.getByLabel('页面标题')).toHaveValue('编辑功能验证'); }
async function read(page: Page) { return (await (await page.request.get('/api/workspace')).json()).tree; }
async function toolbar(page: Page, label: string) { await page.getByRole('toolbar', { name: '正文编辑栏' }).getByRole('button', { name: label, exact: true }).click(); }
test.afterEach(async ({ page }, info) => {
    if (info.status !== info.expectedStatus) return;
    await page.keyboard.press('Control+s');
    await expect(page.getByRole('status').filter({ hasText: '当前编辑已保存' })).toBeVisible();
    const closed = page.waitForResponse(response => response.url().endsWith('/workspace/presence') && response.request().postDataJSON()?.close === true);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    const response = await closed; expect(response.ok()).toBeTruthy(); expect(response.request().postDataJSON().dirty).toBe(false);
});

test('窄屏工具栏、目标选择和列筛选不超出视口', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 }); await login(page);
    await toolbar(page, '链接');
    const picker = page.getByRole('dialog', { name: '插入链接' }); await expect(picker).toBeVisible();
    await page.getByRole('combobox', { name: '搜索插入目标' }).fill('技能');
    await page.screenshot({ path: 'test-results/authoring-mobile-picker.png', fullPage: true });
    const bounds = await picker.boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await page.keyboard.press('Escape');
    const grid = page.locator('[data-view="skills-table"]'); await grid.getByRole('button', { name: '筛选 消耗', exact: true }).click();
    const filter = page.getByRole('dialog', { name: '筛选：消耗' }); await expect(filter).toBeVisible();
    await page.screenshot({ path: 'test-results/authoring-mobile-filter.png', fullPage: true });
    const filterBounds = await filter.boundingBox(); expect(filterBounds!.x).toBeGreaterThanOrEqual(0); expect(filterBounds!.x + filterBounds!.width).toBeLessThanOrEqual(390); expect(filterBounds!.y + filterBounds!.height).toBeLessThanOrEqual(844);
    await page.keyboard.press('Escape'); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('工具栏插入链接与嵌入、替换和移除均可撤销，刷新保持 Markdown', async ({ page }) => {
    await login(page);
    const entities: any[] = [{ id: 'authoring-collection', kind: 'collection', title: '筛选验证集合', path: '集合/authoring.json', fields: [{ key: 'cost', label: '消耗', type: 'number', required: false }, { key: 'tag', label: '类别', type: 'select', options: ['攻击','防御'], required: false }] }, { id: 'authoring-table', kind: 'view', title: '筛选验证表格', path: '视图/authoring.json', collection: 'authoring-collection', layout: 'table', columns: ['title','cost','tag'], filter: null, sort: null }, { id: 'authoring-doc', kind: 'object', title: '编辑功能验证', path: '验证/authoring.md', collection: null, fields: {}, body: '# 编辑功能验证\n\n初始正文' }];
    for (let index = 0; index < 35; index++) entities.push({ id: 'authoring-row-' + String(index).padStart(2,'0'), kind: 'object', path: '验证记录/' + index + '.md', title: '筛选记录 ' + index, collection: 'authoring-collection', fields: { cost: index, tag: index % 2 ? '攻击' : '防御' }, body: '' });
    const result = await page.request.post('/api/workspace/operations', { headers: { 'x-workbench-client': 'test' }, data: { requestId: crypto.randomUUID(), operations: entities.map(entity => ({ type: 'put', entity, expected: null })) } }); expect(result.ok()).toBeTruthy();
    await openDocument(page);
    const editor = page.locator('.milkdown .editor');
    await editor.press('Control+End'); await page.keyboard.press('Enter');
    await toolbar(page, '链接');
    await page.getByRole('combobox', { name: '搜索插入目标' }).fill('技能说明');
    await page.getByRole('option', { name: /技能说明/ }).click();
    await expect(editor.getByRole('link', { name: '技能说明' })).toBeVisible();
    await expect.poll(async () => (await read(page))['authoring-doc'].body).toContain('(doc:guide)');
    await editor.press('Control+End'); await page.keyboard.press('Enter');
    await toolbar(page, '嵌入视图'); await page.getByRole('combobox', { name: '搜索插入目标' }).fill('筛选验证表格'); await page.getByRole('option', { name: /筛选验证表格/ }).click();
    const grid = editor.locator('[data-view="authoring-table"]');
    await expect(grid).toBeVisible();
    await expect(editor.locator('p')).not.toContainText([':::view[authoring-table]']);
    await expect.poll(async () => (await read(page))['authoring-doc'].body).toContain(':::view[authoring-table]');
    await editor.getByRole('button', { name: '嵌入块操作', exact: true }).click(); await page.getByRole('menuitem', { name: '移除此处嵌入' }).click(); await expect(grid).toHaveCount(0);
    await toolbar(page, '撤销正文修改'); await expect(grid).toBeVisible();
    await editor.getByRole('button', { name: '嵌入块操作', exact: true }).click(); await page.getByRole('menuitem', { name: '更换嵌入目标' }).click(); await page.getByRole('combobox', { name: '搜索插入目标' }).fill('技能卡片'); await page.getByRole('option', { name: /技能卡片/ }).click(); await expect(editor.locator('[data-view="skills-cards"]')).toBeVisible();
    await toolbar(page, '撤销正文修改'); await expect(grid).toBeVisible();
    await page.reload(); await openDocument(page); await expect(grid).toBeVisible();
    await page.screenshot({ path: 'test-results/editor-authoring.png', fullPage: true });
});
test('斜杠命令可搜索、键盘确认与取消，中文输入不抢键', async ({ page }) => {
    await login(page); await openDocument(page); const editor = page.locator('.milkdown .editor');
    await editor.press('Control+End'); await page.keyboard.press('Enter'); await page.keyboard.insertText('/文档');
    await expect(page.getByRole('listbox', { name: '斜杠命令' })).toBeVisible();
    await editor.dispatchEvent('compositionstart'); await editor.dispatchEvent('keydown', { key: 'Enter', isComposing: true }); await expect(page.getByRole('dialog', { name: '嵌入文档' })).toHaveCount(0); await editor.dispatchEvent('compositionend'); await expect(page.getByRole('listbox', { name: '斜杠命令' })).toBeVisible();
    await page.keyboard.press('Enter'); await expect(page.getByRole('dialog', { name: '嵌入文档' })).toBeVisible();
    await page.getByRole('combobox', { name: '搜索插入目标' }).fill('技能说明'); await page.keyboard.press('Enter');
    await expect(editor.locator('.document-embed')).toBeVisible();
    await expect.poll(async () => (await read(page))['authoring-doc'].body).toContain(':::doc[guide]');
    await editor.press('Control+End'); await page.keyboard.press('Enter'); await page.keyboard.insertText('/'); await page.keyboard.press('Escape'); await expect(page.getByRole('listbox', { name: '斜杠命令' })).toHaveCount(0); await page.keyboard.press('Backspace');
    await page.keyboard.insertText('组合输入'); await expect(editor).toContainText('组合输入');
    await editor.press('Control+End'); await page.keyboard.press('Enter'); await toolbar(page, '链接'); await page.getByRole('combobox', { name: '搜索插入目标' }).fill('琥珀纸鹤'); await expect(page.getByRole('listbox', { name: '插入目标' })).toContainText('没有匹配'); await page.keyboard.press('Escape');
});
test('多列筛选、跨嵌入同步、排序和分页保持可编辑且可撤销', async ({ page }) => {
    await login(page); await openDocument(page);
    const grid = page.locator('[data-view="authoring-table"]');
    await grid.getByRole('button', { name: '筛选 消耗', exact: true }).click();
    await page.getByLabel('筛选方式', { exact: true }).selectOption('gte'); await page.getByLabel('筛选值', { exact: true }).fill('10'); await page.getByRole('button', { name: '应用筛选', exact: true }).click();
    await expect(grid.locator('tbody tr')).toHaveCount(25);
    await grid.getByRole('button', { name: '筛选 类别', exact: true }).click(); await page.getByRole('dialog', { name: '筛选：类别' }).getByLabel('攻击', { exact: true }).check(); await page.getByRole('button', { name: '应用筛选', exact: true }).click(); await expect(grid.locator('tbody tr')).toHaveCount(12);
    await grid.getByLabel('每页条数').selectOption('10'); await expect(grid.locator('tbody tr')).toHaveCount(10); await grid.getByRole('button', { name: '下一页', exact: true }).click(); await expect(grid.locator('tbody tr')).toHaveCount(2);
    const head = (await (await page.request.get('/api/workspace')).json()).workspace.head;
    await grid.getByRole('button', { name: '上一页', exact: true }).click(); expect((await (await page.request.get('/api/workspace')).json()).workspace.head).toBe(head);
    await grid.getByRole('button', { name: '筛选 消耗', exact: true }).click(); await page.getByRole('button', { name: '降序 ↓', exact: true }).click(); await expect(grid.locator('tbody tr').first()).toContainText('筛选记录 33');
    await page.locator('.collection-navigation').getByRole('button', { name: '筛选验证集合', exact: true }).click(); await expect(grid.locator('tbody tr')).toHaveCount(10); await expect(grid.getByLabel('当前筛选条件')).toContainText('消耗');
    await grid.getByTitle('卡片', { exact: true }).click(); await expect(grid.locator('.record-cards article')).toHaveCount(10); await grid.getByTitle('表格', { exact: true }).click();
    await grid.getByRole('button', { name: '清除全部', exact: true }).click(); await expect(grid).toContainText('筛选后 35 条');
    await grid.focus(); await page.keyboard.press('Control+z'); await expect(grid).toContainText('筛选后 12 条');
    await grid.getByRole('button', { name: '筛选 消耗', exact: true }).click(); await page.screenshot({ path: 'test-results/column-filter.png', fullPage: true }); await page.keyboard.press('Escape');
    await grid.getByRole('button', { name: '清除全部', exact: true }).click(); await grid.getByLabel('每页条数').selectOption('all');
});
