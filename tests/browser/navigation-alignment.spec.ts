import { test, expect, type Locator } from '@playwright/test';
const center = (locator: Locator) => locator.evaluate(element => { const rect=element.getBoundingClientRect(); return rect.x+rect.width/2; });
const aligned = async (left: Locator, right: Locator) => expect(Math.abs(await center(left)-await center(right))).toBeLessThan(1);
test('草稿导航统一层级、箭头占位和更多操作，桌面与窄屏保持对齐', async ({ page }) => {
    expect((await page.request.post('/api/login',{headers:{'x-workbench-client':'test'},data:{username:'designer',password:'e2e-password-123'}})).ok()).toBe(true);
    const entities = [
        { id:'alignment-root', kind:'object', title:'根页面对齐检查', path:'根页面对齐.md', collection:null, fields:{}, body:'' },
        { id:'alignment-nested', kind:'object', title:'这是一篇用于验证窄屏长标题不会挤走更多操作按钮的页面', path:'层级/子层/深层.md', collection:null, fields:{}, body:'' }
    ];
    expect((await page.request.post('/api/workspace/operations', { headers:{'x-workbench-client':'test'}, data:{requestId:crypto.randomUUID(),operations:entities.map(entity=>({type:'put',entity,expected:null}))} })).ok()).toBe(true);
    try {
    await page.goto('/'); await expect(page.getByLabel('页面标题')).toBeVisible();
    const sidebar=page.getByRole('complementary',{name:'项目导航'}), folder=sidebar.locator('summary[data-directory-path="设计"]'), collection=sidebar.locator('.collection-nav-row[data-entity-id="skills"]');
    const disclosure=collection.getByRole('button',{name:/集合 技能$/});
    await expect(sidebar.locator('[data-entity-id="alignment-root"]')).toBeVisible();
    if(await disclosure.getAttribute('aria-expanded')!=='true')await disclosure.click();
    for(const width of [1440,390]) {
        await page.setViewportSize({width,height:1000}); if(width===390)await page.getByRole('button',{name:'打开导航'}).click();
        await aligned(folder.locator('> svg').first(),disclosure.locator('svg'));
        await aligned(folder.locator('> svg').nth(1),collection.locator('.collection-link > svg'));
        await aligned(folder.locator('> svg').nth(1),sidebar.locator('.file-list > .file-entry[data-entity-id="alignment-root"] > button:first-child > svg'));
        const groups=sidebar.locator('.nav-group > summary'); await aligned(groups.nth(0).locator('> svg').first(),groups.nth(1).locator('> svg').first());
        const indent=await center(folder.locator('> svg').first())-await center(groups.nth(0).locator('> svg').first()); expect(indent).toBeGreaterThan(0);
        const nested=sidebar.locator('summary[data-directory-path="层级/子层"]'); expect(await center(nested.locator('> svg').first())-await center(sidebar.locator('summary[data-directory-path="层级"]').locator('> svg').first())).toBeCloseTo(indent,1);
        await aligned(sidebar.locator('.file-entry[data-entity-id="overview"] > button:first-child > svg'),sidebar.locator('.view-nav-row[data-entity-id="skills-table"] .nav-item > svg'));
        await aligned(folder.getByRole('button'),collection.locator('.more-actions')); await aligned(folder.getByRole('button'),sidebar.locator('.view-nav-row[data-entity-id="skills-table"] .more-actions'));
        const initialPosition=await center(disclosure.locator('svg')); await disclosure.focus(); await page.keyboard.press('Space'); await expect(disclosure).toHaveAttribute('aria-expanded','false'); expect(await center(disclosure.locator('svg'))).toBeCloseTo(initialPosition,1); await page.keyboard.press('Space'); await expect(disclosure).toHaveAttribute('aria-expanded','true');
        const wasOpen=await folder.evaluate(element=>(element.parentElement as HTMLDetailsElement).open); await folder.getByRole('button',{name:'更多操作 设计'}).click(); await expect(page.getByRole('menu')).toBeVisible(); expect(await folder.evaluate(element=>(element.parentElement as HTMLDetailsElement).open)).toBe(wasOpen); await page.keyboard.press('Escape');
        await expect(sidebar.getByText('我的草稿',{exact:true})).toBeVisible(); await expect(sidebar.getByText('自动保存，发布后更新团队正式设计',{exact:true})).toBeVisible();
        expect(await sidebar.locator('.sidebar-content').evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);
        await page.screenshot({path:'test-results/draft-navigation-'+width+'.png',fullPage:true});
    }
    } finally {
        const tree=(await(await page.request.get('/api/workspace')).json()).tree;
        const operations=entities.filter(entity=>tree[entity.id]).map(entity=>({type:'delete',id:entity.id,expected:tree[entity.id]}));
        if(operations.length)expect((await page.request.post('/api/workspace/operations',{headers:{'x-workbench-client':'test'},data:{requestId:crypto.randomUUID(),operations}})).ok()).toBe(true);
    }
});
