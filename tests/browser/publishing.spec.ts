import { test, expect, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';
const headers = { 'x-workbench-client': 'test' };
async function login(page: Page) { await page.goto('/'); await page.getByLabel('账号', { exact: true }).fill('designer'); await page.getByLabel('密码', { exact: true }).fill('e2e-password-123'); await page.getByRole('button', { name: '登录' }).click(); await expect(page.locator('.milkdown .editor')).toBeVisible(); }
async function read(page: Page) { return (await (await page.request.get('/api/workspace')).json()).tree; }
async function mutate(page: Page, operations: unknown[]) { const result = await page.request.post('/api/workspace/operations', { headers, data: { requestId: crypto.randomUUID(), operations } }); expect(result.ok(), await result.text()).toBe(true); }
async function discardItem(page: Page, row: any) { await row.getByRole('button', { name: '丢弃此项修改', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '丢弃这些草稿修改？' }); await expect(dialog).toBeVisible(); await dialog.getByRole('button', { name: '确认丢弃', exact: true }).click(); await expect(dialog).toHaveCount(0); }
test.afterEach(async ({ page }, info) => { if (info.status !== info.expectedStatus) return; await page.keyboard.press('Control+s'); await expect(page.getByRole('status').filter({ hasText: '当前编辑已保存' })).toBeVisible(); const closed = page.waitForResponse(response => response.url().endsWith('/workspace/presence') && response.request().postDataJSON()?.close === true); await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide'))); expect((await closed).request().postDataJSON().dirty).toBe(false); });
test('发布前丢弃空白片段、字段与文件，保留其他修改并可撤销', async ({ page }) => {
    await login(page);
    await mutate(page, [{ type: 'patch', id: 'overview', before: '每一次选择', after: '每一次 选择' }, { type: 'patch', id: 'overview', before: '3 点能量', after: '6 点能量' }, { type: 'field', id: 'frost', key: 'cost', expected: 2, value: 7 }]);
    await expect(page.getByLabel('霜刃 消耗')).toHaveValue('7'); await page.getByRole('button', { name: '发布变更', exact: true }).click();
    const publish = page.getByRole('dialog', { name: '发布正式设计' });
    await publish.locator('.review-files button').filter({ hasText: '战斗概览' }).click();
    await publish.getByLabel('显示空白符').check(); await expect(publish.locator('.review-change').filter({ hasText: '每一次·选择' })).toBeVisible(); await publish.getByLabel('显示空白符').uncheck();
    await page.screenshot({ path: 'test-results/publish-review.png', fullPage: true });
    await discardItem(page, publish.locator('.review-change').filter({ hasText: '每一次 选择' }));
    expect((await read(page)).overview.body).not.toContain('每一次 选择'); expect((await read(page)).overview.body).toContain('6 点能量');
    await publish.getByRole('button', { name: '撤销刚才的丢弃', exact: true }).click(); await expect(publish.locator('.review-change').filter({ hasText: '每一次 选择' })).toBeVisible();
    await discardItem(page, publish.locator('.review-change').filter({ hasText: '每一次 选择' }));
    await publish.locator('.review-files button').filter({ hasText: '霜刃' }).click(); await discardItem(page, publish.locator('.review-change').filter({ hasText: '消耗' })); expect((await read(page)).frost.fields.cost).toBe(2);
    await publish.locator('.review-files button').filter({ hasText: '战斗概览' }).click(); await publish.getByLabel('文件操作 战斗概览').click(); await publish.getByRole('button', { name: '丢弃此文件的全部修改' }).click();
    await page.getByRole('dialog', { name: '丢弃这些草稿修改？' }).getByRole('button', { name: '确认丢弃', exact: true }).click(); await expect(page.getByRole('dialog', { name: '丢弃这些草稿修改？' })).toHaveCount(0);
    expect((await read(page)).overview.body).toContain('3 点能量'); await publish.getByRole('button', { name: '关闭', exact: true }).click();
});
test('丢弃新增集合明确展示关联影响，并拒绝过期预览', async ({ page }) => {
    await login(page); const entities = [{ id: 'discard-browser-set', kind: 'collection', title: '丢弃验证集合', path: '丢弃/set.json', fields: [] }, { id: 'discard-browser-row', kind: 'object', title: '丢弃验证记录', path: '丢弃/row.md', collection: 'discard-browser-set', fields: {}, body: '' }];
    await mutate(page, entities.map(entity => ({ type: 'put', entity, expected: null })));
    await page.getByRole('button', { name: '发布变更', exact: true }).click(); const publish = page.getByRole('dialog', { name: '发布正式设计' }); await publish.locator('.review-files button').filter({ hasText: '丢弃验证集合' }).click();
    await publish.getByRole('button', { name: '丢弃此项修改', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '丢弃这些草稿修改？' }); await expect(dialog).toContainText('丢弃验证记录');
    await dialog.getByRole('button', { name: '保留修改' }).click(); expect((await read(page))['discard-browser-row']).toBeDefined();
    await mutate(page, [{ type: 'field', id: 'guard', key: 'cost', expected: 1, value: 2 }]); await expect(publish).toContainText('草稿或团队正式版本已更新'); await expect(publish.getByRole('button', { name: '丢弃此项修改', exact: true })).toBeDisabled();
    await publish.getByRole('button', { name: '重新检查修改', exact: true }).click(); await expect(publish.getByRole('button', { name: '丢弃此项修改', exact: true })).toBeEnabled(); await publish.getByRole('button', { name: '丢弃此项修改', exact: true }).click();
    await dialog.getByRole('button', { name: '确认丢弃及关联修改', exact: true }).click(); await expect(dialog).toHaveCount(0); expect((await read(page))['discard-browser-row']).toBeUndefined();
    await publish.getByRole('button', { name: '关闭', exact: true }).click(); await mutate(page, [{ type: 'field', id: 'guard', key: 'cost', expected: 2, value: 1 }]);
});
test('真实 MCP 丢弃遵守会话，Web 可撤销 Agent 的丢弃', async ({ page }) => {
    await login(page); const issued = await page.request.post('/api/tokens', { headers, data: { name: 'discard-mcp', scopes: ['workspace.read','workspace.write'] } }); const { token } = await issued.json();
    const client = new Client({ name: 'discard-browser', version: '1.0.0' }); await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import','tsx',resolve('src/agent/main.ts')], env: { ...process.env as Record<string,string>, WORKBENCH_URL: 'http://127.0.0.1:14319', WORKBENCH_TOKEN: token } }));
    const call = async (name: string, args: any = {}) => { const result: any = await client.callTool({ name, arguments: args }); expect(result.isError, JSON.stringify(result)).not.toBe(true); return JSON.parse(result.content[0].text); };
    try {
        await call('workspace_apply', { requestId: crypto.randomUUID(), operations: [{ type: 'field', id: 'guard', key: 'cost', expected: 1, value: 5 }] }); await call('workspace_write_session', { action: 'release' });
        const preview = await call('design_preview'); const item = preview.review.find((item: any) => item.id === 'guard' && item.property === 'cost');
        const plan = await call('workspace_discard_preview', { head: preview.head, base: preview.base, main: preview.main, targets: [{ id: 'guard', key: item.key }] });
        await call('workspace_discard', { requestId: crypto.randomUUID(), head: plan.head, base: plan.base, main: plan.main, targets: plan.targets });
        await expect(page.getByLabel('守势 消耗')).toHaveValue('1'); await call('workspace_write_session', { action: 'release' }); await expect(page.getByRole('button', { name: '收回控制权' })).toHaveCount(0);
        await page.locator('tr[data-entity-id="guard"]').focus(); await page.keyboard.press('Control+z'); await expect(page.getByLabel('守势 消耗')).toHaveValue('5');
        await mutate(page, [{ type: 'field', id: 'guard', key: 'cost', expected: 5, value: 1 }]);
    } finally { await client.close(); }
});
