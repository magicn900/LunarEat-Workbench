
test('断线期间保留人工输入，重连合并 Agent 的非重叠修改',async({page,browser})=>{
 await login(page);await expect(page.locator('.milkdown .editor')).toBeVisible();await expect(page.locator('.saved')).toBeVisible();
 const agentContext=await browser.newContext();const agentPage=await agentContext.newPage();await login(agentPage);
 await page.context().setOffline(true);await page.locator('.milkdown .editor').press('Control+End');await page.keyboard.press('Enter');await page.keyboard.insertText('断线期间保留的人工输入。');
 const change=await agentPage.request.post('/api/workspace/operations',{headers:{'x-workbench-client':'test'},data:{requestId:'offline-agent-edit',groupId:'offline-agent',operations:[{type:'patch',id:'overview',before:'每一次选择',after:'每一个想法'}]}});expect(change.ok()).toBeTruthy();
 await page.context().setOffline(false);await expect(page.locator('.milkdown .editor')).toContainText('每一个想法');await expect(page.locator('.milkdown .editor')).toContainText('断线期间保留的人工输入');await expect(page.locator('.saved')).toBeVisible();
 await expect.poll(async()=>{const result=await page.request.get('/api/workspace');return (await result.json()).tree.overview.body.includes('断线期间保留的人工输入');}).toBe(true);
 await agentContext.close();
});
import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';
async function login(page:any,username='designer'){await page.goto('/');await page.getByLabel('账号',{exact:true}).fill(username);await page.getByLabel('密码',{exact:true}).fill('e2e-password-123');await page.getByRole('button',{name:'登录'}).click();await expect(page.getByLabel('页面标题')).toBeVisible();}
test('Web、真实 MCP、共享视图、发布与代码同步完整闭环',async({page,browser})=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await login(page);await expect(page.locator('.milkdown .editor')).toBeVisible();await expect(page.getByLabel('霜刃 消耗').first()).toHaveValue('2');
 await page.screenshot({path:'test-results/workspace.png',fullPage:true});
 const issued=await page.request.post('/api/tokens',{headers:{'x-workbench-client':'test'},data:{name:'MCP verification',scopes:['workspace.read','workspace.write','inspiration.read']}});expect(issued.ok()).toBeTruthy();const {token}=await issued.json();
 const client=new Client({name:'acceptance-test',version:'1.0.0'});const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx',resolve('src/agent/main.ts')],cwd:process.cwd(),env:{...process.env as Record<string,string>,WORKBENCH_URL:'http://127.0.0.1:14319',WORKBENCH_TOKEN:token}});await client.connect(transport);
 try{
  const tools=await client.listTools();expect(tools.tools.some(tool=>tool.name==='inspiration_search')).toBeTruthy();
  const result=await client.callTool({name:'workspace_apply',arguments:{requestId:'mcp-e2e-edit',groupId:'mcp-e2e-task',operations:[{type:'field',id:'frost',key:'cost',expected:2,value:3},{type:'patch',id:'overview',before:'3 点能量',after:'4 点能量'}]}});expect(result.isError,JSON.stringify(result)).not.toBe(true);
  await expect(page.getByLabel('霜刃 消耗').first()).toHaveValue('3');await expect(page.locator('.milkdown .editor')).toContainText('4 点能量');
  await expect(page.getByRole('button',{name:'收回控制权'})).toBeVisible();
  expect((await client.callTool({name:'workspace_write_session',arguments:{action:'release'}})).isError).not.toBe(true);
  await expect(page.getByRole('button',{name:'收回控制权'})).toHaveCount(0);
  await page.locator('.milkdown .editor').getByRole('link',{name:'技能说明',exact:true}).click();await expect(page.getByLabel('页面标题')).toHaveValue('技能说明');await expect(page.getByLabel('霜刃 消耗').first()).toHaveValue('3');await page.getByLabel('霜刃 消耗').first().fill('4');await page.getByLabel('霜刃 消耗').first().press('Tab');
  await page.locator('.collection-navigation').getByRole('button',{name:'技能',exact:true}).click();await page.locator('.collection-navigation').getByRole('button',{name:'技能速览',exact:true}).click();await expect(page.locator('[data-view="skills-table"]').getByLabel('霜刃 消耗')).toHaveValue('4');
  await page.getByRole('button',{name:'发布变更',exact:true}).click();await page.getByLabel('变更标题',{exact:true}).fill('验证：调整技能消耗');await page.getByLabel('变更说明',{exact:true}).fill('来自真实 MCP 与浏览器的共同编辑');const published = page.waitForResponse(response => response.url().endsWith('/api/publish') && response.request().method() === 'POST'); await page.getByRole('button',{name:'发布为正式设计'}).click(); expect((await published).ok()).toBeTruthy();await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('button',{name:'发布记录',exact:true}).click();await expect(page.locator('.change-card')).toContainText('待同步');
  const programmerContext=await browser.newContext();const programmer=await programmerContext.newPage();await login(programmer,'developer');await programmer.getByRole('button',{name:'发布记录',exact:true}).click();await programmer.getByRole('button',{name:'批量确认',exact:true}).click();await programmer.getByLabel('选择 验证：调整技能消耗').check();await programmer.getByRole('button',{name:'确认所选记录已同步至实现',exact:true}).click();await programmer.getByLabel('代码仓库标识').fill('demo://unverified-example');await programmer.getByLabel('实现版本（代码 commit）').fill('demonstration-only');await programmer.getByLabel('确认说明').fill('演示输入：不表示真实代码已经验证。');await programmer.getByRole('button',{name:'将 1 条记录确认为已同步至实现'}).click();await expect(programmer.locator('.change-card')).toContainText('已确认同步至实现');await programmerContext.close();
  const regular=await client.callTool({name:'workspace_search',arguments:{query:'琥珀纸鹤'}});expect(JSON.stringify(regular)).not.toContain('隔离验证词');const ideas=await client.callTool({name:'inspiration_search',arguments:{query:'琥珀纸鹤'}});expect(JSON.stringify(ideas)).toContain('隔离验证词');
  await page.getByRole('button',{name:/灵感池/}).click();await expect(page.locator('.note')).toHaveCount(2);await page.screenshot({path:'test-results/inspiration.png',fullPage:true});
 }finally{await client.close();}
 expect(errors).toEqual([]);
});
test('中文输入自动保存、刷新恢复与移动端布局',async({page})=>{await login(page);const editor=page.locator('.milkdown .editor');await expect(editor).toBeVisible();await editor.focus();await editor.press('Control+End');await page.keyboard.press('Enter');await page.keyboard.insertText('中文保存验证，人工继续编辑。');await expect(editor).toContainText('中文保存验证');await expect.poll(async()=>((await(await page.request.get('/api/workspace')).json()).tree.overview.body.includes('中文保存验证'))).toBe(true);await page.reload();await expect(page.locator('.milkdown .editor')).toContainText('中文保存验证');await page.setViewportSize({width:390,height:844});await expect(page.locator('.milkdown .editor')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();await page.screenshot({path:'test-results/mobile.png',fullPage:true});});
