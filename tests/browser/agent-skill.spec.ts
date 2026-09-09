import { test, expect } from '@playwright/test';
test('Skill 安装入口可复制、不含密钥、支持窄屏且不锁工作区', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read','clipboard-write']);
    expect((await page.request.post('/api/login',{headers:{'x-workbench-client':'test'},data:{username:'designer',password:'e2e-password-123'}})).ok()).toBe(true);
    const before=await (await page.request.get('/api/workspace')).json();
    await page.goto('/');await page.getByRole('button',{name:'账号菜单',exact:true}).click();await page.getByRole('menuitem',{name:'设置',exact:true}).click();await page.getByRole('tab',{name:'Agent 接入',exact:true}).click();
    await page.getByRole('button',{name:'复制给 Agent 的安装指令',exact:true}).click();
    const text=await page.evaluate(()=>navigator.clipboard.readText());expect(text).toContain('/api/agent/kit/manifest.json');expect(text).toContain('不申请控制权');expect(text).not.toContain('YOUR_TOKEN');expect(text).not.toContain('node_modules');
    await page.getByText('手动安装与连接',{exact:true}).click();await expect(page.getByRole('link',{name:'阅读安装说明'})).toHaveAttribute('href','/api/agent/kit/references/connection.md');
    await expect(page.getByText('连接方式与 MCP 配置',{exact:true})).toHaveCount(0);
    await page.screenshot({path:'.local-data/agent-skill-desktop.png',fullPage:true,animations:'disabled'});
    await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:'.local-data/agent-skill-mobile.png',fullPage:true,animations:'disabled'});
    const after=await(await page.request.get('/api/workspace')).json();expect(after.tree).toEqual(before.tree);expect(after.control).toBeNull();
});

test('远程 HTTP 安装提示要求明确授权，并给出临时配置选项', async ({ page }) => {
    expect((await page.request.post('/api/login', { headers: { 'x-workbench-client': 'test' }, data: { username: 'settings-user', password: 'e2e-password-123' } })).ok()).toBe(true);
    await page.route('http://workbench.test:14319/**', async route => {
        const target = new URL(route.request().url());
        const response = await page.request.fetch('http://127.0.0.1:14319' + target.pathname + target.search, { method: route.request().method(), data: route.request().postData() ?? undefined });
        await route.fulfill({ response });
    });
    await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: undefined }); document.execCommand = () => false; });
    await page.goto('http://workbench.test:14319');
    await page.getByRole('button', { name: '账号菜单', exact: true }).click();
    await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: 'Agent 接入', exact: true }).click();
    await expect(page.getByRole('note')).toContainText('明文传输');
    await page.getByRole('button', { name: '复制给 Agent 的安装指令', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '手动复制', exact: true });
    const prompt = await dialog.getByRole('textbox', { name: '待复制内容' }).inputValue();
    expect(prompt).toContain('仅在我明确批准此地址后'); expect(prompt).toContain('--allow-insecure-http'); expect(prompt).toContain('不要声称已连接');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByText('手动安装与连接', { exact: true }).click();
    await expect(page.locator('.agent-connection pre')).toContainText('--allow-insecure-http');
});
