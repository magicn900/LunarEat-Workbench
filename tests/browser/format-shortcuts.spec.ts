import { test, expect, type Page } from '@playwright/test';
test.afterEach(async ({ page }) => {
    const identity = await (await page.request.get('/api/identity')).json();
    if (identity.preferences) expect((await page.request.post('/api/account/preferences', { headers: { 'x-workbench-client': 'test' }, data: { ...identity.preferences, shortcuts: {} } })).ok()).toBe(true);
});

async function setup(page: Page) {
    const headers = { 'x-workbench-client': 'test' };
    await page.request.post('/api/login', { headers, data: { username: 'designer', password: 'e2e-password-123' } });
    const identity = await (await page.request.get('/api/identity')).json();
    await page.request.post('/api/account/preferences', { headers, data: { ...identity.preferences, theme: 'dark', language: 'zh-CN', shortcuts: {} } });
    await page.goto('/');
    await expect(page.locator('.milkdown .editor')).toBeVisible();
    const id = crypto.randomUUID();
    const entity = { id, kind: 'object', title: id, path: '格式测试/' + id + '.md', collection: null, fields: {}, body: '需要强调的文字' };
    expect((await page.request.post('/api/workspace/operations', { headers, data: { requestId: crypto.randomUUID(), operations: [{ type: 'put', expected: null, entity }] } })).ok()).toBeTruthy();
    await page.keyboard.press('Control+k');
    await page.getByRole('textbox', { name: '搜索命令与页面' }).fill(id);
    await page.getByRole('button', { name: '打开：' + id, exact: true }).click();
    await expect(page.getByLabel('页面标题')).toHaveValue(id);
    return id;
}
async function settings(page: Page) {
    await page.getByRole('button', { name: '账号菜单', exact: true }).click();
    await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: '快捷键', exact: true }).click();
}
async function bind(page: Page, label: string, keys: string) {
    await page.getByRole('button', { name: '修改快捷键：' + label, exact: true }).click();
    await page.getByRole('textbox', { name: '录入快捷键：' + label, exact: true }).press(keys);
    await expect(page.getByRole('textbox', { name: '录入快捷键：' + label, exact: true })).toHaveCount(0);
}
const source = async (page: Page, id: string) => (await (await page.request.get('/api/documents/' + id + '/source')).json()).body as string;

test('高亮和删除线支持保存、撤销、只读嵌入及源码往返', async ({ page }) => {
    const id = await setup(page), editor = page.locator('.milkdown .editor');
    await editor.click(); await editor.press('Control+Home'); await editor.press('Control+Shift+End');
    await page.getByRole('button', { name: '高亮', exact: true }).click();
    await expect(editor.locator('mark')).toHaveText('需要强调的文字');
    await expect.poll(() => source(page, id)).toContain('==需要强调的文字==');
    await page.getByRole('button', { name: '删除线', exact: true }).click();
    await expect(editor.locator('del')).toHaveText('需要强调的文字');
    await expect.poll(() => source(page, id)).toContain('~~');
    await page.getByRole('button', { name: '撤销正文修改' }).click();
    await expect(editor.locator('del')).toHaveCount(0);
    await expect(editor.locator('mark')).toBeVisible();
    await page.getByRole('button', { name: '重做正文修改' }).click();
    await expect(editor.locator('del')).toBeVisible();
    await expect.poll(() => source(page, id)).toContain('~~');
    await page.reload(); await expect(editor.locator('mark')).toBeVisible(); await expect(editor.locator('del')).toBeVisible();
    await page.getByRole('button', { name: '编辑 Markdown 源码' }).click();
    await expect(page.getByRole('textbox', { name: 'Markdown 源码', exact: true })).toHaveValue(await source(page, id));
    await page.getByRole('button', { name: '尝试富文本编辑' }).click();
    await expect(editor.locator('mark')).toBeVisible();
    await page.screenshot({ path: '.local-data/format-highlight-dark.png', fullPage: true });
    const embeddedId = crypto.randomUUID();
    const embedded = { id: embeddedId, kind: 'object', title: embeddedId, path: '格式测试/' + embeddedId + '.md', collection: null, fields: {}, body: ':::doc[' + id + ']' };
    expect((await page.request.post('/api/workspace/operations', { headers: { 'x-workbench-client': 'test' }, data: { requestId: crypto.randomUUID(), operations: [{ type: 'put', expected: null, entity: embedded }] } })).ok()).toBeTruthy();
    await page.keyboard.press('Control+k');
    await page.getByRole('textbox', { name: '搜索命令与页面' }).fill(embeddedId);
    await page.getByRole('button', { name: '打开：' + embeddedId, exact: true }).click();
    await expect(page.locator('.document-embed mark')).toBeVisible();
    await expect(page.locator('.document-embed del')).toBeVisible();
});

test('设置录入绑定并校验冲突，旧按键失效，刷新后继续生效', async ({ page }) => {
    const id = await setup(page), editor = page.locator('.milkdown .editor');
    await settings(page);
    await page.getByRole('button', { name: '修改快捷键：高亮', exact: true }).click();
    await page.getByRole('textbox', { name: '录入快捷键：高亮' }).press('Control+b');
    await expect(page.locator('.keyboard-settings [role="alert"]')).toContainText('冲突');
    await page.getByRole('textbox', { name: '录入快捷键：高亮' }).press('Escape');
    await bind(page, '加粗', 'Control+Shift+b');
    await bind(page, '高亮', 'Control+Alt+h');
    await bind(page, '删除线', 'Control+Shift+x');
    await bind(page, '命令与页面搜索', 'Control+Shift+p');
    await page.screenshot({ path: '.local-data/keyboard-settings-dark.png', fullPage: true });
    await page.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
    await editor.click(); await editor.press('Control+Home'); await editor.press('Control+Shift+End');
    await page.keyboard.press('Control+b');
    await expect(editor.locator('strong')).toHaveCount(0);
    await page.keyboard.press('Control+Shift+b');
    await expect(editor.locator('strong')).toBeVisible();
    await page.keyboard.press('Control+Alt+h'); await expect(editor.locator('mark')).toBeVisible();
    await page.keyboard.press('Control+Shift+x'); await expect(editor.locator('del')).toBeVisible();
    await expect.poll(() => source(page, id)).toContain('~~');
    await expect(page.getByRole('button', { name: '高亮', exact: true })).toHaveAttribute('title', '高亮 · Ctrl+Alt+H');
    await page.keyboard.press('Control+k'); await expect(page.getByRole('dialog', { name: '命令面板' })).toHaveCount(0);
    await page.keyboard.press('Control+Shift+p'); await expect(page.getByRole('dialog', { name: '命令面板' })).toBeVisible();
    await page.keyboard.press('Escape'); await page.reload();
    await expect(page.getByRole('button', { name: '加粗', exact: true })).toHaveAttribute('title', '加粗 · Ctrl+Shift+B');
    await settings(page);
    await page.getByRole('button', { name: '清除快捷键：高亮' }).click();
    await expect(page.getByRole('button', { name: '清除快捷键：高亮' })).toBeDisabled();
    await page.getByRole('button', { name: '恢复快捷键：加粗' }).click();
    await expect(page.getByRole('button', { name: '恢复快捷键：加粗' })).toBeDisabled();
    await page.setViewportSize({ width: 700, height: 900 });
    await expect(page.getByRole('button', { name: '修改快捷键：高亮' })).toBeInViewport();
});
