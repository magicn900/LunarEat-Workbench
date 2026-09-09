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
