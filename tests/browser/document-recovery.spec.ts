import { expect, test, type Page } from '@playwright/test';

async function login(page: Page) {
    await page.goto('/');
    await page.getByLabel('账号', { exact: true }).fill('designer');
    await page.getByLabel('密码', { exact: true }).fill('e2e-password-123');
    await page.getByRole('button', { name: '登录', exact: true }).click();
}
async function failRichText(page: Page) {
    await page.route('**/api/documents/**', async route => {
        if (route.request().method() === 'GET' && !new URL(route.request().url()).pathname.endsWith('/source')) {
            await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: '图片 title 为 null，无法渲染', code: 'DOCUMENT_RENDER_FAILED', requestId: 'recovery-test' }) });
        } else await route.continue();
    });
}
test('加载失败自动降级，源码可保存、刷新恢复并重试富文本', async ({ page }) => {
    await failRichText(page); await login(page);
    const input = page.getByRole('textbox', { name: 'Markdown 源码', exact: true });
    await expect(input).toBeEnabled();
    await expect(page.locator('.markdown-source [role="status"]')).toContainText('recovery-test');
    await input.fill('源码降级保存测试');
    await page.getByRole('button', { name: '保存源码', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: '源码已保存' })).toBeVisible();
    await page.reload(); await expect(input).toHaveValue('源码降级保存测试');
    await page.unroute('**/api/documents/**');
    await page.getByRole('button', { name: '尝试富文本编辑' }).click();
    await expect(page.locator('.milkdown .editor')).toContainText('源码降级保存测试');
    await page.getByRole('button', { name: '编辑 Markdown 源码' }).click();
    await expect(input).toHaveValue('源码降级保存测试');
});
test('源码保存冲突保留输入并要求对照，未确认保存复用 requestId', async ({ page }) => {
    await failRichText(page); await login(page);
    const input = page.getByRole('textbox', { name: 'Markdown 源码', exact: true });
    await expect(input).toBeEnabled(); await input.fill('本机冲突内容');
    let attempts = 0; const requests: string[] = [];
    await page.route('**/api/documents/*/source', async route => {
        if (route.request().method() === 'GET') { await route.continue(); return; }
        requests.push(route.request().postDataJSON().requestId); attempts++;
        if (attempts === 1) await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '暂时故障', requestId: 'uncertain' }) });
        else await route.continue();
    });
    await page.getByRole('button', { name: '保存源码', exact: true }).click();
    await expect(input).toBeDisabled();
    await page.getByRole('button', { name: '重试确认保存' }).click();
    await expect(input).toBeEnabled(); expect(requests[1]).toBe(requests[0]);
    await input.fill('不要丢失的本机输入');
    await page.route('**/api/documents/*/source', async route => {
        if (route.request().method() === 'POST') await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: '正文已被修改' }) });
        else await route.continue();
    });
    await page.getByRole('button', { name: '保存源码', exact: true }).click();
    await expect(input).toHaveValue('不要丢失的本机输入');
    await expect(page.getByRole('textbox', { name: '最新服务端源码' })).toBeVisible();
});
