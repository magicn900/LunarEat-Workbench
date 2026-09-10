import { expect, test, type Page } from '@playwright/test';
const headers = { 'x-workbench-client': 'test' };
test.afterEach(async ({ page }) => {
    const identity = await (await page.request.get('/api/identity')).json();
    if (identity.preferences) await page.request.post('/api/account/preferences', { headers, data: { ...identity.preferences, shortcuts: {} } });
});
const slash = String.fromCharCode(92), newline = String.fromCharCode(10);
async function setup(page: Page, body: string) {
    expect((await page.request.post('/api/login', { headers, data: { username: 'designer', password: 'e2e-password-123' } })).ok()).toBe(true);
    const identity = await (await page.request.get('/api/identity')).json();
    await page.request.post('/api/account/preferences', { headers, data: { ...identity.preferences, theme: 'dark', language: 'zh-CN', shortcuts: {} } });
    await page.goto('/'); await expect(page.locator('.milkdown .editor')).toBeVisible();
    const id = crypto.randomUUID();
    const entity = { id, kind: 'object', title: id, path: '公式测试/' + id + '.md', collection: null, fields: {}, body };
    expect((await page.request.post('/api/workspace/operations', { headers, data: { requestId: crypto.randomUUID(), operations: [{ type: 'put', expected: null, entity }] } })).ok()).toBe(true);
    await open(page, id);
    return id;
}
async function open(page: Page, id: string) {
    await page.keyboard.press('Control+k'); await page.getByRole('textbox', { name: '搜索命令与页面' }).fill(id);
    await page.getByRole('button', { name: '打开：' + id, exact: true }).click();
    await expect(page.getByLabel('页面标题')).toHaveValue(id);
}
const source = async (page: Page, id: string) => (await (await page.request.get('/api/documents/' + id + '/source')).json()).body as string;
const formula = (page: Page) => page.locator('.milkdown .editor [data-math]').first();
async function edit(page: Page) { await formula(page).locator('.math-rendered').click(); await expect(formula(page)).toHaveClass(/math-editing/); return formula(page).locator('.math-source'); }

test('直接输入行内和独立公式，转义和行内代码不误触发', async ({ page }) => {
    const id = await setup(page, '起始 ');
    const editor = page.locator('.milkdown .editor'); await editor.click(); await editor.press('Control+End');
    await page.keyboard.type('$a+b$'); await expect(formula(page)).toHaveClass(/math-editing/);
    await expect(formula(page).locator('.math-source')).toHaveText('a+b');
    await page.keyboard.press('Escape'); await page.keyboard.press('Enter');
    await page.keyboard.type('$$'); await page.keyboard.press('Enter');
    await page.keyboard.insertText('D=1');
    await expect(editor.locator('[data-math="block"] .math-source')).toHaveText('D=1');
    await page.keyboard.press('Escape'); await page.keyboard.type(slash + '$price$');
    await page.keyboard.press('Enter');
    const tick = String.fromCharCode(96); await page.keyboard.type(tick + '$notformula$' + tick);
    await expect(editor.locator('code')).toHaveText('$notformula$');
    await expect(editor.locator('[data-math]')).toHaveCount(2);
    await expect.poll(() => source(page, id)).toContain('$a+b$');
});

test('预览线程超时仍能编辑保存，公式快捷键可绑定', async ({ page }) => {
    await page.addInitScript(() => { window.Worker = class { postMessage() {} terminate() {} } as any; });
    const id = await setup(page, '超时 $x$');
    const input = await edit(page); await input.fill('y+1');
    await expect.poll(() => source(page, id)).toContain('$y+1$');
    await expect(page.locator('.math-preview .math-error')).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Escape');
    const identity = await (await page.request.get('/api/identity')).json();
    expect((await page.request.post('/api/account/preferences', { headers, data: { ...identity.preferences, shortcuts: { 'math-inline': 'Mod+Alt+M' } } })).ok()).toBe(true);
    await page.reload(); await page.locator('.milkdown .editor').click(); await page.keyboard.press('Control+End'); await page.keyboard.press('Escape'); await page.keyboard.insertText(' ');
    await page.keyboard.press('Control+Alt+m'); await page.keyboard.insertText('z');
    await expect.poll(() => source(page, id)).toContain('$z$');
});

test('表格内原位源码与旁侧预览，错误仍自动保存，刷新和撤销不丢输入', async ({ page }) => {
    const id = await setup(page, ['| 阶段 | 模型输出 |', '| --- | --- |', '| 训练 | 概率分布 $P(w_1), P(w_2)$ |', '', '表格之后'].join(newline));
    await expect(formula(page).locator('.katex')).toBeVisible();
    const input = await edit(page);
    await expect(input).toHaveText('P(w_1), P(w_2)');
    await expect(page.getByRole('note', { name: '公式实时预览' })).toBeVisible();
    await input.fill(slash + 'frac{a}{b}');
    await expect(page.locator('.math-preview .katex')).toBeVisible();
    await expect.poll(() => source(page, id)).toContain(slash + 'frac{a}{b}');
    await input.fill(slash + 'frac{');
    await expect(page.locator('.math-preview .math-error')).toBeVisible();
    await expect.poll(() => source(page, id)).toContain(slash + 'frac{');
    await page.screenshot({ path: '.local-data/math-table-error-dark.png', fullPage: true });
    await page.keyboard.press('Escape'); await expect(page.locator('.math-preview')).toHaveCount(0);
    await expect(formula(page).locator('.math-error')).toBeVisible();
    await page.reload(); await expect(formula(page).locator('.math-error')).toBeVisible();
    const restored = await edit(page); await restored.fill('a+b');
    await page.keyboard.press('Control+s'); await expect.poll(() => source(page, id)).toContain('$a+b$');
    await page.reload(); const again = await edit(page);
    await again.fill('a+c'); await page.keyboard.press('Control+s');
    await expect.poll(() => source(page, id)).toContain('$a+c$');
    await page.keyboard.press('Control+z'); await expect.poll(() => source(page, id)).toContain('$a+b$');
    await page.keyboard.press('Control+Shift+z'); await expect.poll(() => source(page, id)).toContain('$a+c$');
});

test('菜单插入、键盘进出、空公式删除、独立公式多行自动保存', async ({ page }) => {
    const id = await setup(page, '公式前后');
    const editor = page.locator('.milkdown .editor'); await editor.click(); await editor.press('Control+End');
    await page.getByRole('combobox', { name: '插入', exact: true }).selectOption('math-inline');
    await page.keyboard.insertText('x^2'); await expect(formula(page)).toHaveClass(/math-editing/);
    await page.keyboard.press('Escape'); await expect(formula(page)).not.toHaveClass(/math-editing/);
    await page.keyboard.press('ArrowLeft'); await expect(formula(page)).toHaveClass(/math-editing/);
    await formula(page).locator('.math-source').fill('');
    await page.keyboard.press('Escape'); await expect(formula(page).locator('.math-rendered')).toHaveText('空公式');
    await expect.poll(() => source(page, id)).toContain('$ $');
    await page.reload(); await expect(formula(page).locator('.math-rendered')).toHaveText('空公式');
    await edit(page); await page.keyboard.press('Backspace');
    await expect(editor.locator('[data-math]')).toHaveCount(0);
    await page.getByRole('combobox', { name: '插入', exact: true }).selectOption('math-block');
    await page.keyboard.insertText('a=1'); await page.keyboard.press('Enter'); await page.keyboard.insertText('b=2');
    await expect(formula(page).locator('.math-source')).toHaveText('a=1' + newline + 'b=2');
    await expect.poll(() => source(page, id)).toContain(['$$', 'a=1', 'b=2', '$$'].join(newline));
    await page.keyboard.press('Escape'); await page.keyboard.insertText('公式之后');
    await expect.poll(() => source(page, id)).toContain('公式之后');
});

test('源码往返、只读嵌入和窄屏公式预览不挤宽表格', async ({ page }) => {
    const id = await setup(page, '文本 $x^2$');
    await page.getByRole('button', { name: '编辑 Markdown 源码' }).click();
    const raw = page.getByRole('textbox', { name: 'Markdown 源码', exact: true });
    expect(await raw.inputValue()).toContain('$x^2$');
    await page.getByRole('button', { name: '尝试富文本编辑' }).click();
    await expect(formula(page).locator('.katex')).toBeVisible();
    const embed = crypto.randomUUID();
    expect((await page.request.post('/api/workspace/operations', { headers, data: { requestId: crypto.randomUUID(), operations: [{ type: 'put', expected: null, entity: { id: embed, kind: 'object', title: embed, path: '公式测试/' + embed + '.md', collection: null, fields: {}, body: ':::doc[' + id + ']' } }] } })).ok()).toBe(true);
    await open(page, embed); await expect(page.locator('.document-embed .katex')).toBeVisible();
    await open(page, id); await page.setViewportSize({ width: 390, height: 844 });
    await edit(page); await expect(page.locator('.math-preview')).toBeVisible();
    const rect = (await page.locator('.math-preview').boundingBox())!;
    expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.x + rect.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.local-data/math-mobile-dark.png', fullPage: true });
});

test('危险宏、超长公式及预览线程失效不会阻塞正文编辑', async ({ page }) => {
    const id = await setup(page, '$' + slash + 'href{javascript:alert(1)}{x}$');
    await expect(formula(page).locator('.math-error')).toBeVisible();
    await expect(formula(page).locator('a')).toHaveCount(0);
    const input = await edit(page); await input.fill('x'.repeat(12001));
    await expect(page.locator('.math-preview .math-error')).toBeVisible();
    await expect.poll(() => source(page, id)).toContain('x'.repeat(12001));
    await page.addInitScript(() => { window.Worker = class { constructor() { throw Error('preview blocked'); } } as any; });
    await page.reload(); const next = await edit(page); await next.fill('unique+1');
    await expect(page.locator('.math-preview .math-error')).toBeVisible();
    await expect.poll(() => source(page, id)).toContain('$unique+1$');
    await page.keyboard.press('Escape'); await page.keyboard.insertText('仍可输入');
    await expect.poll(() => source(page, id)).toContain('仍可输入');
});
