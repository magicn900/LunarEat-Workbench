import { test,expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';
async function login(page:any){await page.goto('/');await page.getByLabel('账号',{exact:true}).fill('designer');await page.getByLabel('密码',{exact:true}).fill('e2e-password-123');await page.getByRole('button',{name:'登录'}).click();await expect(page.getByLabel('页面标题')).toBeVisible();}
test('右键与键盘菜单、撤销重做、命令面板与原生输入互不抢占',async({page})=>{
 await login(page);await page.locator('.collection-navigation').getByRole('button',{name:'技能',exact:true}).click();await page.locator('.collection-navigation').getByRole('button',{name:'技能速览',exact:true}).click();
 const grid=page.locator('[data-view="skills-table"]');
 await grid.locator('tr[data-entity-id="frost"]').locator('.row-title').click({button:'right'});
 await expect(page.getByRole('menu')).toBeVisible();await expect(page.getByRole('menuitem',{name:'删除记录'})).toBeVisible();await expect(page.getByRole('menuitem',{name:'删除集合'})).toHaveCount(0);
 await page.screenshot({path:'test-results/context-menu.png',fullPage:true});
 await page.keyboard.press('Escape');await expect(page.getByRole('menu')).toHaveCount(0);
 await grid.getByLabel('霜刃 消耗').click({button:'right'});await expect(page.getByRole('menu')).toHaveCount(0);await page.keyboard.press('Escape');
 await grid.locator('tr[data-entity-id="frost"]').focus();await page.keyboard.press('Shift+F10');await expect(page.getByRole('menu')).toBeVisible();await page.keyboard.press('End');await expect(page.getByRole('menuitem',{name:'删除记录'})).toBeFocused();await page.keyboard.press('Escape');
 await grid.getByLabel('霜刃 消耗').fill('8');await grid.getByLabel('霜刃 消耗').press('Tab');await expect.poll(async()=>((await(await page.request.get('/api/workspace')).json()).tree.frost.fields.cost)).toBe(8);
 await grid.locator('tr[data-entity-id="frost"]').focus();await page.keyboard.press('Control+z');await expect(grid.getByLabel('霜刃 消耗')).toHaveValue('2');await page.keyboard.press('Control+Shift+z');await expect(grid.getByLabel('霜刃 消耗')).toHaveValue('8');await page.keyboard.press('Control+z');await expect(grid.getByLabel('霜刃 消耗')).toHaveValue('2');
 page.once('dialog',dialog=>dialog.accept('快捷键目录'));await page.getByRole('button',{name:'新建内容',exact:true}).click();await page.getByRole('menuitem',{name:'新建文件夹',exact:true}).click();await expect(page.locator('summary[data-directory-path="快捷键目录"]')).toBeVisible();await page.getByRole('button',{name:'新建内容',exact:true}).focus();await page.keyboard.press('Control+z');await expect(page.locator('summary[data-directory-path="快捷键目录"]')).toHaveCount(0);
 await page.keyboard.press('Control+k');await page.getByRole('textbox',{name:'搜索命令与页面'}).fill('快捷键');await page.keyboard.press('Enter');await expect(page.getByRole('dialog',{name:'快捷键说明'})).toBeVisible();await page.keyboard.press('Escape');
 await page.keyboard.press('Control+Shift+f');await expect(page.locator('.search input')).toBeFocused();
 await page.locator('.file-list').getByRole('button',{name:'战斗概览',exact:true}).click(); await page.getByLabel('页面标题').click();await page.keyboard.press('Control+s');await expect(page.getByRole('status').filter({hasText:'不会自动发布'})).toBeVisible();
 await page.locator('.milkdown .editor > p').first().click();await page.keyboard.press('Control+f');await page.getByRole('textbox',{name:'查找正文'}).fill('技能');await expect(page.locator('.document-find')).toContainText('/');await page.keyboard.press('Escape');
});
test('复制标签页不能复用交接身份',async({page})=>{
 await login(page);
 const original=await page.evaluate(()=>sessionStorage.getItem('workbench-client'));
 const popupPromise=page.waitForEvent('popup');await page.evaluate(()=>window.open('/'));
 const popup=await popupPromise;await expect(popup.getByLabel('页面标题')).toBeVisible();
 await expect.poll(()=>popup.evaluate(()=>sessionStorage.getItem('workbench-client'))).not.toBe(original);
 await popup.close();
});
test('真实 MCP 首次交接、人工收回、显式重申与正文统一撤销重做',async({page,browser})=>{
 await login(page);
 const headers={'x-workbench-client':'test'};
 await page.request.post('/api/workspace/operations',{headers,data:{requestId:crypto.randomUUID(),operations:[{type:'put',expected:null,entity:{id:'session-doc',kind:'object',path:'测试/session.md',title:'会话验证',collection:null,fields:{},body:'# 会话验证\n\n原始内容'}}]}});
 await page.locator('.file-entry').getByRole('button',{name:'会话验证',exact:true}).click();await expect(page.locator('.milkdown .editor')).toContainText('原始内容');
 const issued=await page.request.post('/api/tokens',{headers,data:{name:'session-test',scopes:['workspace.read','workspace.write']}});const {token}=await issued.json();
 const client=new Client({name:'session-test',version:'1.0.0'});await client.connect(new StdioClientTransport({command:process.execPath,args:['--import','tsx',resolve('src/agent/main.ts')],env:{...process.env as Record<string,string>,WORKBENCH_URL:'http://127.0.0.1:14319',WORKBENCH_TOKEN:token}}));
 try{
  await page.getByLabel('页面标题').fill('会话验证（人工）');
  const change=await client.callTool({name:'workspace_apply',arguments:{requestId:'session-change-1',operations:[{type:'patch',id:'session-doc',before:'原始内容',after:'Agent 第一轮\n\n:::doc[guide]\n\n:::view[skills-table]'}]}});expect(change.isError,JSON.stringify(change)).not.toBe(true);
  await expect(page.locator('.milkdown .editor')).toContainText('Agent 第一轮');await expect(page.locator('.milkdown .editor')).toHaveAttribute('contenteditable','false');
  await expect(page.locator('.milkdown .document-embed')).toBeVisible(); await expect(page.locator('.milkdown [data-view="skills-table"]')).toBeVisible();
  await expect(page.getByLabel('页面标题')).toHaveValue('会话验证（人工）');
  await expect.poll(async()=>((await(await page.request.get('/api/workspace')).json()).tree['session-doc'].title)).toBe('会话验证（人工）');
  await expect(page.getByRole('button',{name:'新建内容',exact:true})).toBeDisabled();
  await page.screenshot({path:'test-results/agent-writing.png',fullPage:true});
  await page.getByRole('button',{name:'收回控制权'}).click();await expect(page.locator('.milkdown .editor')).toHaveAttribute('contenteditable','true');
  await expect(page.getByRole('button',{name:'新建内容',exact:true})).toBeEnabled();
  const denied=await client.callTool({name:'workspace_apply',arguments:{requestId:'session-change-2',operations:[{type:'patch',id:'session-doc',before:'Agent 第一轮',after:'不应写入'}]}});expect(denied.isError).toBe(true);expect(JSON.stringify(denied)).toContain('WRITE_SESSION_REVOKED');
  const omitted=await page.request.post('/api/workspace/operations',{headers:{authorization:'Bearer '+token},data:{requestId:'session-omit',taskId:'new-task-bypass',operations:[{type:'patch',id:'session-doc',before:'Agent 第一轮',after:'不应写入'}]}});expect(omitted.status()).toBe(409);expect((await omitted.json()).code).toBe('WRITE_SESSION_REVOKED');
  await page.locator('.milkdown .editor > p').first().click();await page.keyboard.press('Control+z');await expect(page.locator('.milkdown .editor')).toContainText('原始内容'); await expect(page.locator('.milkdown .embedded-host')).toHaveCount(0);await page.keyboard.press('Control+Shift+z');await expect(page.locator('.milkdown .editor')).toContainText('Agent 第一轮'); await expect(page.locator('.milkdown .embedded-host')).toHaveCount(2);
  const request=await client.callTool({name:'workspace_write_session',arguments:{action:'request',title:'第二轮修改'}});
  if(request.isError){expect(JSON.stringify(request)).toContain('CONTROL_HANDOFF_PENDING');await expect(page.getByRole('button',{name:'收回控制权'})).toBeVisible();}
  const changed=await client.callTool({name:'workspace_apply',arguments:{requestId:'session-change-3',operations:[{type:'patch',id:'session-doc',before:'Agent 第一轮',after:'Agent 第二轮'}]}});
  expect(changed.isError,JSON.stringify(changed)).not.toBe(true);
  expect((await client.callTool({name:'workspace_write_session',arguments:{action:'release'}})).isError).not.toBe(true);
  await expect(page.locator('.milkdown .editor')).toContainText('Agent 第二轮');await expect(page.getByRole('button',{name:'收回控制权'})).toHaveCount(0);
  await page.locator('.milkdown .editor > p').first().click();await page.keyboard.press('Control+z');await expect(page.locator('.milkdown .editor')).toContainText('Agent 第一轮');
  await page.screenshot({path:'test-results/session-interactions.png',fullPage:true});
 }finally{await client.close();}
});
