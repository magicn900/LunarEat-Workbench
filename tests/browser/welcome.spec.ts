import { test, expect, type Page } from '@playwright/test';
const headers = { 'x-workbench-client': 'test' };
const login = async (page: Page, username: string) => { expect((await page.request.post('/api/login', { headers, data: { username, password: 'e2e-password-123' } })).ok()).toBe(true); };
test('管理员引导不授予项目权限，顶部菜单向下展开且窄屏可操作', async ({ page }) => {
    await login(page, 'test-admin'); await page.goto('/');
    await expect(page.getByRole('heading', { name: '管理平台，或加入项目开始策划' })).toBeVisible();
    await expect(page.getByText('请联系管理员授权。')).toHaveCount(0);
    expect((await (await page.request.get('/api/identity')).json()).projects).toEqual([]);
    await page.screenshot({ path: '.local-data/welcome-light.png', fullPage: true });
    const bar = page.getByRole('button', { name: '账号菜单', exact: true });
    await bar.click(); const menu = page.getByRole('menu', { name: '账号操作' });
    await expect(menu).toBeVisible();
    await expect.poll(async () => (await menu.boundingBox())!.y >= (await bar.boundingBox())!.y + (await bar.boundingBox())!.height).toBe(true);
    await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: '通用', exact: true }).click();
    await page.getByRole('radio', { name: '深色', exact: true }).click(); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
    await page.screenshot({ path: '.local-data/welcome-dark.png', fullPage: true });
    await page.setViewportSize({ width:390, height:844 }); await bar.click(); await expect(menu).toBeVisible();
    const bounds = (await menu.boundingBox())!; expect(bounds.y).toBeGreaterThan(0); expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.local-data/welcome-mobile.png', fullPage: true });
    await page.keyboard.press('Escape'); await expect(bar).toBeFocused();
    await page.getByRole('link', { name: '进入平台管理', exact: true }).click(); await expect(page).toHaveURL(/admin$/);
});
test('普通无项目账号刷新失败有反馈，授权后刷新进入只读设计', async ({ page }) => {
    await login(page, 'test-admin');
    const created = await page.request.post('/api/admin/users', { headers, data: { username: 'welcome-member', password:'e2e-password-123' } }); expect(created.ok()).toBe(true); const userId = (await created.json()).id;
    const administrator = await page.context().browser()!.newContext({ baseURL: 'http://127.0.0.1:14319' });
    await administrator.request.post('/api/login', { headers, data: { username:'test-admin', password:'e2e-password-123' } });
    try {
        await login(page,'welcome-member'); await page.goto('/');
        await expect(page.getByRole('heading', { name:'还没有可访问的项目' })).toBeVisible(); await expect(page.getByRole('link',{name:'进入平台管理',exact:true})).toHaveCount(0);
        await page.route('**/api/identity', route => route.fulfill({ status:503, contentType:'application/json', body:JSON.stringify({ error:'暂时无法刷新' }) }));
        await page.getByRole('button',{name:'刷新访问权限'}).click(); await expect(page.getByRole('alert')).toBeVisible(); await expect(page.getByRole('status')).not.toContainText('访问权限已刷新');
        await page.unroute('**/api/identity');
        expect((await administrator.request.post('/api/admin/member',{headers,data:{userId,projectId:'demo',scopes:['workspace.read'],expectedScopes:null}})).ok()).toBe(true);
        await page.getByRole('button',{name:'刷新访问权限'}).click(); await expect(page.locator('.ProseMirror').first()).toHaveAttribute('contenteditable','false');
    } finally { await administrator.close(); }
});
test('项目成员只展示已授权功能，灵感池点击后才读取', async ({ page }) => {
    await login(page,'test-admin'); const created=await page.request.post('/api/admin/users',{headers,data:{username:'welcome-inspiration',password:'e2e-password-123'}}); expect(created.ok()).toBe(true); const userId=(await created.json()).id;
    expect((await page.request.post('/api/admin/member',{headers,data:{userId,projectId:'demo',scopes:['inspiration.read'],expectedScopes:null}})).ok()).toBe(true);
    await login(page,'welcome-inspiration'); const reads:string[]=[]; page.on('request',request=>{ if(request.url().includes('/api/inspiration')) reads.push(request.url()); });
    await page.goto('/'); await expect(page.getByRole('heading',{name:'你已加入项目'})).toBeVisible(); await expect(page.locator('.welcome-project')).toBeVisible(); expect(reads).toEqual([]);
    await page.getByRole('button',{name:'打开灵感池',exact:true}).click(); await expect(page.getByRole('button',{name:'记下灵感'})).toBeDisabled(); await expect.poll(()=>reads.length).toBeGreaterThan(0); await expect(page.locator('.ProseMirror')).toHaveCount(0);
    await page.getByRole('button',{name:'返回开始使用'}).click(); await expect(page.getByRole('heading',{name:'你已加入项目'})).toBeVisible();
});
