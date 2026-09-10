import { expect, test, type Page } from '@playwright/test';

const newline = String.fromCharCode(10);
async function login(page: Page) {
    await page.goto('/');
    await page.getByLabel('账号', { exact: true }).fill('designer');
    await page.getByLabel('密码', { exact: true }).fill('e2e-password-123');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('.milkdown .editor')).toBeVisible();
}
async function create(page: Page, entities: unknown[]) {
    const response = await page.request.post('/api/workspace/operations', { headers: { 'x-workbench-client': 'test' }, data: { requestId: crypto.randomUUID(), operations: entities.map(entity => ({ type: 'put', expected: null, entity })) } });
    expect(response.ok()).toBeTruthy();
}
async function open(page: Page, title: string) {
    await page.keyboard.press('Control+k');
    await page.getByRole('textbox', { name: '搜索命令与页面' }).fill(title);
    await page.getByRole('button', { name: '打开：' + title, exact: true }).click();
    await expect(page.getByLabel('页面标题')).toHaveValue(title);
    await expect(page.locator('.milkdown .editor')).toBeVisible();
}
const documentEntity = (id: string, title: string, body: string) => ({ id, kind: 'object', title, path: '阅读验证/' + id + '.md', collection: null, fields: {}, body });

test('插入入口收进更多下拉栏，原生选项在深浅主题都有明确配色', async ({ page }) => {
    await login(page);
    const menu = page.getByRole('combobox', { name: '插入', exact: true });
    await expect(menu.locator('option[value="table"]')).toHaveText('表格');
    await expect(menu.locator('option[value="image"]')).toHaveText('图片');
    await expect(page.getByRole('button', { name: '插入表格', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '插入图片', exact: true })).toHaveCount(0);
    for (const theme of ['dark', 'light']) {
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
        await expect(menu.locator('option[value="table"]')).toHaveCSS('background-color', theme === 'dark' ? 'rgb(34, 34, 37)' : 'rgb(255, 254, 251)');
        await expect(menu.locator('option[value="table"]')).toHaveCSS('color', theme === 'dark' ? 'rgb(230, 230, 233)' : 'rgb(40, 55, 47)');
        await menu.focus();
        await expect(menu).toBeFocused();
    }
    await page.setViewportSize({ width: 720, height: 900 });
    await expect(menu).toBeInViewport();
});

test('站内前进后退、鼠标侧键、刷新与阅读位置恢复', async ({ page }) => {
    await login(page);
    const boundarySession = await page.context().newCDPSession(page);
    const initialURL = page.url();
    await boundarySession.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 650, y: 450, button: 'back', buttons: 8, clickCount: 1 });
    await boundarySession.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 650, y: 450, button: 'back', buttons: 0, clickCount: 1 });
    await expect(page.getByLabel('页面标题')).toHaveValue('战斗概览');
    expect(page.url()).toBe(initialURL);
    const id = crypto.randomUUID();
    const title = '阅读位置 ' + id;
    const destination = '跳转目标 ' + id;
    const body = Array.from({ length: 60 }, (_, index) => '阅读段落 ' + index + '：' + '这是用于验证定位的正文。'.repeat(8)).join(newline + newline);
    await create(page, [documentEntity(id, title, body), documentEntity(id + '-other', destination, '目标页面')]);
    await open(page, title);
    const scroll = page.locator('.document-scroll');
    await scroll.evaluate(element => { element.scrollTop = 950; });
    await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBe(950);
    await open(page, destination);
    await page.getByRole('button', { name: '返回上一页', exact: true }).click();
    await expect(page.getByLabel('页面标题')).toHaveValue(title);
    await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeCloseTo(950, 0);
    await page.goForward();
    await expect(page.getByLabel('页面标题')).toHaveValue(destination);
    const session = await page.context().newCDPSession(page);
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 650, y: 450, button: 'back', buttons: 8, clickCount: 1 });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 650, y: 450, button: 'back', buttons: 0, clickCount: 1 });
    await expect(page.getByLabel('页面标题')).toHaveValue(title);
    await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeCloseTo(950, 0);
    await page.reload();
    await expect(page.getByLabel('页面标题')).toHaveValue(title);
    await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeCloseTo(950, 0);
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 650, y: 450, button: 'forward', buttons: 16, clickCount: 1 });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 650, y: 450, button: 'forward', buttons: 0, clickCount: 1 });
    await expect(page.getByLabel('页面标题')).toHaveValue(destination);
    await page.goBack();
    await expect(page.getByLabel('页面标题')).toHaveValue(title);
    await page.locator('.file-list').getByRole('button', { name: '战斗概览', exact: true }).click();
    await expect(page.getByRole('button', { name: '前进到下一页', exact: true })).toBeDisabled();
    const length = await page.evaluate(() => history.length);
    await page.locator('.file-list').getByRole('button', { name: '战斗概览', exact: true }).click();
    expect(await page.evaluate(() => history.length)).toBe(length);
});

test('正文变动后按段落恢复，清除前进分支仍保留页面记忆', async ({ page }) => {
    await login(page);
    const id = crypto.randomUUID();
    const title = '段落锚定 ' + id;
    const destination = '段落跳转 ' + id;
    const body = Array.from({ length: 40 }, (_, index) => '唯一段落 ' + index + '：' + '阅读位置验证。'.repeat(12)).join(newline + newline);
    await create(page, [documentEntity(id, title, body), documentEntity(id + '-other', destination, '[返回原文](doc:' + id + ')')]);
    await open(page, title);
    const scroll = page.locator('.document-scroll');
    await scroll.evaluate(element => { element.scrollTop = 800; });
    const anchor = await scroll.evaluate(element => {
        const edge = element.getBoundingClientRect().top;
        const block = [...element.querySelectorAll('.editor > p')].find(block => block.getBoundingClientRect().bottom > edge)!;
        return { text: block.textContent, offset: block.getBoundingClientRect().top - edge };
    });
    await open(page, destination);
    const original = (await (await page.request.get('/api/workspace')).json()).tree[id];
    const response = await page.request.post('/api/workspace/operations', { headers: { 'x-workbench-client': 'test' }, data: { requestId: crypto.randomUUID(), operations: [{ type: 'put', expected: original, entity: { ...original, body: '插入在原文前的新增段落。'.repeat(80) + newline + newline + body } }] } });
    expect(response.ok()).toBeTruthy();
    await page.getByRole('button', { name: '返回上一页', exact: true }).click();
    await expect.poll(() => scroll.evaluate((element, saved) => {
        const block = [...element.querySelectorAll('.editor > p')].find(block => block.textContent === saved.text);
        return block ? Math.abs(block.getBoundingClientRect().top - element.getBoundingClientRect().top - saved.offset) : 999;
    }, anchor)).toBeLessThan(2);
    await page.locator('.file-list').getByRole('button', { name: '战斗概览', exact: true }).click();
    await open(page, destination);
    await page.getByRole('link', { name: '返回原文', exact: true }).click();
    await expect(page.getByLabel('页面标题')).toHaveValue(title);
    await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(800);
});

test('长文本完整换行、黑灰主题、集合横向位置和失败导航保护', async ({ page }) => {
    await login(page);
    const id = crypto.randomUUID();
    const long = '每周期首次弃牌抽一张，触发后继续结算后续效果。'.repeat(10);
    await create(page, [
        { id, kind: 'collection', title: '长文本集合 ' + id, path: '集合/' + id + '.json', fields: [{ key: 'description', label: '效果说明', type: 'text', required: false }, { key: 'notes', label: '补充说明', type: 'text', required: false }, { key: 'extra', label: '其他', type: 'text', required: false }] },
        { id: id + '-view', kind: 'view', title: '长文本表格 ' + id, path: '视图/' + id + '.json', collection: id, layout: 'table', columns: ['description', 'notes', 'extra'], filter: null, sort: null },
        { ...documentEntity(id + '-row', '长文本记录 ' + id, '记录正文'), collection: id, fields: { description: long, notes: '短内容', extra: '补充' } }
    ]);
    await page.locator('.collection-navigation').getByRole('button', { name: '长文本集合 ' + id, exact: true }).click();
    const field = page.getByLabel('长文本记录 ' + id + ' 效果说明');
    await expect(field).toHaveValue(long);
    expect(await field.evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    expect((await field.boundingBox())!.height).toBeGreaterThan(90);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--paper').trim())).toBe('#18181b');
    await page.screenshot({ path: 'test-results/reading-dark-collection.png', fullPage: true, animations: 'disabled' });
    await page.setViewportSize({ width: 850, height: 800 });
    const table = page.locator('.content .table-scroll');
    await table.evaluate(element => { element.scrollLeft = 150; });
    const left = await table.evaluate(element => element.scrollLeft);
    expect(left).toBeGreaterThan(0);
    await open(page, '长文本记录 ' + id);
    await expect(page.getByLabel('页面标题')).toHaveValue('长文本记录 ' + id);
    await page.getByRole('button', { name: '返回上一页', exact: true }).click();
    await expect.poll(() => table.evaluate(element => element.scrollLeft)).toBe(left);
    await field.fill('第一行' + newline + '第二行');
    await field.press('Control+Enter');
    await expect.poll(async () => (await (await page.request.get('/api/workspace')).json()).tree[id + '-row'].fields.description).toBe('第一行' + newline + '第二行');
    await page.route('**/api/workspace/operations', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: '模拟保存冲突' }) }));
    await field.fill('必须保留的未保存输入');
    await page.goBack();
    await expect(page.getByRole('status').filter({ hasText: '模拟保存冲突' })).toBeVisible();
    await expect(field).toHaveValue('必须保留的未保存输入');
    await expect(page.getByRole('button', { name: '返回上一页', exact: true })).toBeEnabled();
    await page.unroute('**/api/workspace/operations');
    await field.press('Control+Enter');
    await expect.poll(async () => (await (await page.request.get('/api/workspace')).json()).tree[id + '-row'].fields.description).toBe('必须保留的未保存输入');
});

test('Markdown 表格快捷编辑、边缘加号、撤销与窄屏', async ({ page }) => {
    await login(page);
    const id = crypto.randomUUID();
    const title = '表格编辑 ' + id;
    await create(page, [documentEntity(id, title, ['| 事件 | 唯一定义 | 不包括 |', '| --- | --- | --- |', '| 打出牌 | 一次成功的手动使用事务 | 自动执行 |', '| 攻击动作 | 单位主动发动的一次攻击 | 反伤 |', '', '表格后面的正文'].join(newline))]);
    await open(page, title);
    const editor = page.locator('.milkdown .editor');
    const table = editor.locator('table').first();
    await table.locator('td').first().click();
    const toolbar = page.getByRole('toolbar', { name: 'Markdown 表格编辑' });
    await expect(toolbar).toBeHidden();
    const hoverEdge = async (edge: 'top' | 'left' | 'bottom' | 'right') => {
        const bounds = (await table.boundingBox())!;
        const row = (await table.locator('tr').nth(1).boundingBox())!;
        const header = (await table.locator('th').first().boundingBox())!;
        await page.mouse.move(edge === 'left' ? bounds.x + 2 : edge === 'right' ? bounds.x + bounds.width - 2 : header.x + header.width / 2, edge === 'top' ? bounds.y + 2 : edge === 'bottom' ? bounds.y + bounds.height - 2 : row.y + row.height / 2);
    };
    const center = (await table.boundingBox())!;
    await page.mouse.move(center.x + center.width / 2, center.y + center.height / 2);
    await expect(page.locator('.markdown-table-edges button')).toHaveCount(0);
    const selectionBefore = await page.evaluate(() => ({ text: getSelection()?.anchorNode?.textContent, offset: getSelection()?.anchorOffset }));
    await hoverEdge('top');
    await expect(page.locator('[data-edge="column"]')).toHaveAttribute('data-column', '0');
    expect(await page.evaluate(() => ({ text: getSelection()?.anchorNode?.textContent, offset: getSelection()?.anchorOffset }))).toEqual(selectionBefore);
    await page.getByRole('button', { name: '当前列操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '列居中', exact: true }).click();
    await expect(table.locator('th').first()).toHaveCSS('text-align', 'center');
    await hoverEdge('left');
    await expect(page.locator('[data-edge="row"]')).toHaveAttribute('data-row', '1');
    await page.getByRole('button', { name: '当前行操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '下移此行', exact: true }).click();
    await expect(table.locator('tr').nth(1)).toContainText('攻击动作');
    await hoverEdge('bottom');
    await page.getByRole('button', { name: '在表格末尾添加行', exact: true }).click();
    await expect(table.locator('tr')).toHaveCount(4);
    await hoverEdge('right');
    await page.getByRole('button', { name: '在表格右侧添加列', exact: true }).click();
    await expect(table.locator('th')).toHaveCount(4);
    await page.getByRole('button', { name: '撤销正文修改', exact: true }).click();
    await expect(table.locator('th')).toHaveCount(3);
    await table.locator('tr').last().locator('td').last().click();
    await page.keyboard.press('Tab');
    await expect(table.locator('tr')).toHaveCount(5);
    await page.keyboard.type('末格新增行');
    await expect(table.locator('tr').last()).toContainText('末格新增行');
    await page.keyboard.press('Control+s');
    await expect.poll(async () => (await (await page.request.get('/api/workspace')).json()).tree[id].body).toContain('末格新增行');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await table.locator('td').first().click();
    await page.screenshot({ path: 'test-results/reading-dark-markdown.png', fullPage: true, animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/reading-mobile-markdown.png', fullPage: true, animations: 'disabled' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await editor.locator('p').last().click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.getByRole('combobox', { name: '插入', exact: true }).selectOption('table');
    await expect(editor.locator('table')).toHaveCount(2);
});
