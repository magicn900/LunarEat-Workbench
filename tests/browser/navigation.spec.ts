import { test, expect, type Page } from '@playwright/test';

async function login(page: Page) {
    await page.goto('/');
    await page.getByLabel('账号', { exact: true }).fill('designer');
    await page.getByLabel('密码', { exact: true }).fill('e2e-password-123');
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page.getByLabel('页面标题')).toBeVisible();
}

test('个人内容分层、集合视图定位、记录搜索与共享范围', async ({ page }) => {
    await login(page);
    const response = await page.request.post('/api/workspace/operations', { headers: { 'x-workbench-client': 'test' }, data: { requestId: crypto.randomUUID(), operations: [
        { id: 'nav-collection', kind: 'collection', title: '导航验证集合', path: '集合/nav.json', fields: [] },
        { id: 'nav-table', kind: 'view', title: '导航表格', path: '视图/nav-table.json', collection: 'nav-collection', layout: 'table', columns: ['title'], filter: null, sort: null },
        { id: 'nav-cards', kind: 'view', title: '导航卡片', path: '视图/nav-cards.json', collection: 'nav-collection', layout: 'cards', columns: ['title'], filter: null, sort: null },
        { id: 'nav-record', kind: 'object', title: '导航验证记录', path: '不应出现的记录目录/nav.md', collection: 'nav-collection', fields: {}, body: '# 导航验证记录' }
    ].map(entity => ({ type: 'put', entity, expected: null })) } });
    expect(response.ok()).toBeTruthy();
    const sidebar = page.getByRole('complementary', { name: '项目导航' });
    await expect(sidebar.getByRole('button', { name: '工作区', exact: true })).toHaveCount(0);
    await expect(sidebar.locator('.file-list')).not.toContainText('霜刃');
    await expect(sidebar.locator('.file-list')).not.toContainText('不应出现的记录目录');
    await page.locator('.collection-navigation').getByRole('button', { name: '导航验证集合', exact: true }).click();
    await expect(page.locator('.content .collection-section')).toHaveCount(1);
    await expect(page.locator('.content h1')).toHaveText('导航验证集合');
    await expect(sidebar.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(sidebar.locator('[aria-current="page"]')).toHaveText(await sidebar.locator('.collection-nav-entry').filter({ has: page.getByRole('button', { name: '导航验证集合', exact: true }) }).locator('.view-nav-row .nav-item').first().innerText());
    await sidebar.getByRole('button', { name: '导航表格', exact: true }).click();
    await expect(page.locator('.content [data-view="nav-table"]')).toBeVisible();
    await sidebar.getByRole('button', { name: '导航卡片', exact: true }).click();
    await expect(page.locator('.content [data-view="nav-cards"]')).toBeVisible();
    await expect(page.locator('.content [data-view="nav-table"]')).toHaveCount(0);
    await page.locator('.content').getByRole('button', { name: '导航验证记录', exact: true }).click();
    await expect(page.getByLabel('页面标题')).toHaveValue('导航验证记录');
    await expect(page.getByLabel('当前位置')).toContainText('我的草稿');
    await expect(page.getByLabel('当前位置')).toContainText('导航验证集合');
    await expect(sidebar.locator('[aria-current="page"]')).toHaveCount(0);
    await expect(sidebar.locator('.collection-nav-row.ancestor')).toHaveCount(1);
    await page.getByLabel('当前位置').getByRole('button', { name: '导航验证集合' }).click();
    await expect(page.locator('.content .collection-grid')).toBeVisible();
    await page.getByLabel('搜索策划', { exact: true }).fill('导航验证记录');
    await expect(sidebar.getByLabel('策划搜索结果')).toContainText('导航验证集合');
    await sidebar.getByRole('button', { name: /^导航验证记录/ }).click();
    await expect(page.getByLabel('搜索策划', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('页面标题')).toHaveValue('导航验证记录');
    await sidebar.getByRole('button', { name: /灵感池/ }).click();
    await expect(page.getByLabel('当前位置')).toHaveText('项目共享灵感池');
    await expect(page.getByRole('button', { name: '发布变更', exact: true })).toHaveCount(0);
    await expect(page.locator('.revision-bar')).toHaveCount(0);
    await page.keyboard.press('Control+Shift+f');
    await expect(page.getByLabel('搜索策划', { exact: true })).toBeFocused();
    await page.getByLabel('搜索策划', { exact: true }).fill('琥珀纸鹤');
    await expect(sidebar.getByLabel('策划搜索结果')).toContainText('没有匹配');
    await page.getByRole('button', { name: '清除策划搜索' }).click();
    await sidebar.locator('.file-list').getByRole('button', { name: '战斗概览', exact: true }).click();
    const directory = sidebar.locator('summary[data-directory-path="设计"]');
    await directory.click();
    await expect(page.getByLabel('页面标题')).toHaveValue('战斗概览');
    await expect(sidebar.locator('.file-list').getByRole('button', { name: '战斗概览', exact: true })).toBeHidden();
    await directory.click();
    await page.screenshot({ path: 'test-results/navigation-desktop.png', fullPage: true });
});

test('悬停、焦点、按下与新建菜单均有明确反馈', async ({ page }) => {
    await login(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const link = page.locator('.collection-navigation').getByRole('button', { name: '技能', exact: true });
    const background = await link.evaluate(element => getComputedStyle(element).backgroundColor);
    await link.hover();
    await expect.poll(() => link.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(background);
    await page.keyboard.press('Tab');
    await link.focus();
    await expect(link).toBeFocused();
    await expect.poll(() => link.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid');
    await page.mouse.down();
    await expect.poll(() => link.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe('none');
    await page.mouse.up();
    await expect(page.locator('.content .collection-grid')).toBeVisible();
    await expect(page.locator('.sidebar [aria-current="page"]')).toHaveCount(1);
    await expect(page.locator('.sidebar [aria-current="page"]')).toHaveText(await page.locator('.collection-view-tabs [aria-current="page"]').innerText());
    const create = page.getByRole('button', { name: '新建内容', exact: true });
    await create.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: '新建页面' })).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.getByRole('menuitem', { name: '新建集合' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(create).toBeFocused();
    await expect(page.getByRole('menu', { name: '新建内容' })).toHaveCount(0);
    await page.locator('.file-list').getByRole('button', { name: '战斗概览', exact: true }).click();
    const editor = page.locator('.milkdown .editor');
    await expect(editor).toBeVisible();
    const original = (await (await page.request.get('/api/workspace')).json()).tree.overview.body;
    await editor.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('导航切换保存验证');
    await link.click();
    await expect.poll(async () => (await (await page.request.get('/api/workspace')).json()).tree.overview.body).toContain('导航切换保存验证');
    await page.locator('.file-list').getByRole('button', { name: '战斗概览', exact: true }).click();
    await expect(editor).toContainText('导航切换保存验证');
    await editor.focus();
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await (await page.request.get('/api/workspace')).json()).tree.overview.body).toBe(original);
});

test('窄屏导航可访问、可关闭并保持单一目的地', async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const sidebar = page.getByRole('complementary', { name: '项目导航' });
    await expect(sidebar).toBeHidden();
    const toggle = page.getByRole('button', { name: '打开导航' });
    await toggle.click();
    await expect(sidebar).toBeVisible();
    await expect(page.getByLabel('搜索策划', { exact: true })).toBeFocused();
    await page.screenshot({ path: 'test-results/navigation-mobile.png', fullPage: true });
    await sidebar.locator('.collection-navigation').getByRole('button', { name: '技能', exact: true }).click();
    await expect(sidebar).toBeHidden();
    await expect(page.locator('.content .collection-grid')).toBeVisible();
    await toggle.click();
    await page.keyboard.press('Escape');
    await expect(sidebar).toBeHidden();
    await expect(toggle).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});
