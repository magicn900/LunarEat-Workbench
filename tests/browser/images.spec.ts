import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';

async function setup(page: Page) {
    await page.goto('/');
    await page.getByLabel('账号', { exact: true }).fill('designer');
    await page.getByLabel('密码', { exact: true }).fill('e2e-password-123');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('.milkdown .editor')).toBeVisible();
    const id = crypto.randomUUID();
    const entity = { id, kind: 'object', title: id, path: '图片测试/' + id + '.md', collection: null, fields: {}, body: '图片测试正文' };
    const response = await page.request.post('/api/workspace/operations', { headers: { 'x-workbench-client': 'test' }, data: { requestId: crypto.randomUUID(), operations: [{ type: 'put', expected: null, entity }] } });
    expect(response.ok()).toBeTruthy();
    await page.keyboard.press('Control+k');
    await page.getByRole('textbox', { name: '搜索命令与页面' }).fill(id);
    await page.getByRole('button', { name: '打开：' + id, exact: true }).click();
    await expect(page.getByLabel('页面标题')).toHaveValue(id);
    await expect(page.locator('.milkdown .editor')).toBeVisible();
}
const fixture = async () => ({ name: 'test-image.png', mimeType: 'image/png', buffer: await sharp({ create: { width: 80, height: 40, channels: 3, background: '#317ca0' } }).png().toBuffer() });
async function choose(page: Page) {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('combobox', { name: '插入', exact: true }).selectOption('image');
    await (await chooser).setFiles(await fixture());
}

test('图片上传、说明、原图、移除撤销和刷新持久化', async ({ page }) => {
    await setup(page);
    const editor = page.locator('.milkdown .editor');
    await editor.locator('p').last().click();
    await page.keyboard.press('End');
    await choose(page);
    const image = editor.locator('img[src*="/assets/"]').last();
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(80);
    await image.click();
    const replacement = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '替换图片', exact: true }).click();
    await (await replacement).setFiles({ name: 'replacement.png', mimeType: 'image/png', buffer: await sharp({ create: { width: 120, height: 60, channels: 3, background: '#785ca0' } }).png().toBuffer() });
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(120);
    await expect(editor.locator('img[src*="/assets/"]')).toHaveCount(1);
    await image.click();
    page.once('dialog', dialog => dialog.accept('图片说明测试'));
    await page.getByRole('button', { name: '编辑说明', exact: true }).click();
    await expect(image).toHaveAttribute('alt', '图片说明测试');
    await page.getByRole('button', { name: '查看原图', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: '原始尺寸', exact: true }).click();
    await page.keyboard.press('Escape');
    await image.click();
    await page.getByRole('button', { name: '移除图片', exact: true }).click();
    await expect(image).toHaveCount(0);
    await page.getByRole('button', { name: '撤销正文修改', exact: true }).click();
    await expect(image).toBeVisible();
    await page.keyboard.press('Control+s');
    await expect.poll(async () => JSON.stringify((await (await page.request.get('/api/workspace')).json()).tree)).toContain('图片说明测试');
    await page.reload();
    await expect(editor.locator('img[alt="图片说明测试"]')).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出', exact: true }).click();
    expect((await download).suggestedFilename()).toMatch(/.md.zip$/);
    await page.screenshot({ path: 'test-results/images-desktop.png', fullPage: true });
});

test('上传失败可重试，上传中取消不写入临时地址', async ({ page }) => {
    await setup(page);
    const editor = page.locator('.milkdown .editor');
    await editor.locator('p').last().click();
    await page.route('**/documents/*/images', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '模拟上传失败' }) }));
    await choose(page);
    await expect(page.getByRole('button', { name: '重试上传', exact: true })).toBeVisible();
    await page.unroute('**/documents/*/images');
    await page.getByRole('button', { name: '重试上传', exact: true }).click();
    await expect(editor.locator('img[src*="/assets/"]')).toHaveCount(1);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/documents/*/images', async route => { await gate; await route.abort().catch(() => {}); });
    await choose(page);
    await expect(page.getByRole('group', { name: '图片上传' })).toBeVisible();
    await page.getByRole('button', { name: '取消上传', exact: true }).click();
    release();
    await expect(page.getByRole('group', { name: '图片上传' })).toHaveCount(0);
    await expect(editor.locator('img[src*="/assets/"]')).toHaveCount(1);
    await page.keyboard.press('Control+s');
    const tree = JSON.stringify((await (await page.request.get('/api/workspace')).json()).tree);
    expect(tree).not.toContain('blob:');
    expect(tree).not.toContain('data:image/');
});

test('粘贴截图、拖入图片及上传期间编辑保持插入位置', async ({ page }) => {
    await setup(page);
    const editor = page.locator('.milkdown .editor');
    await editor.locator('p').last().click();
    await page.keyboard.press('End');
    const bytes = [...(await fixture()).buffer];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/documents/*/images', async route => { await gate; await route.continue(); });
    await editor.evaluate((element, bytes) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(bytes)], 'pasted.png', { type: 'image/png' }));
        element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    }, bytes);
    await expect(page.getByRole('group', { name: '图片上传' })).toBeVisible();
    await page.keyboard.press('Home');
    await page.keyboard.insertText('前面新增内容');
    release();
    await expect(editor.locator('img[src*="/assets/"]')).toHaveCount(1);
    await expect(editor.locator('p').last()).toContainText('前面新增内容图片测试正文');
    expect(await editor.locator('img[src*="/assets/"]').evaluate(element => {
        const range = document.createRange();
        range.selectNodeContents(element.parentElement!);
        range.setEndBefore(element);
        return range.toString();
    })).toBe('前面新增内容图片测试正文');
    await page.unroute('**/documents/*/images');
    await editor.evaluate((element, bytes) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(bytes)], 'dropped.png', { type: 'image/png' }));
        const bounds = element.getBoundingClientRect();
        element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: bounds.x + 20, clientY: bounds.y + 15 }));
    }, bytes);
    await expect(editor.locator('img[src*="/assets/"]')).toHaveCount(2);
});
