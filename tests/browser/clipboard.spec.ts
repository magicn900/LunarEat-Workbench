import { test, expect } from '@playwright/test';
test.beforeEach(async ({ page }) => {
    expect((await page.request.post('/api/login', { headers: { 'x-workbench-client': 'test' }, data: { username: 'settings-user', password: 'e2e-password-123' } })).ok()).toBe(true);
});
async function settings(page: import('@playwright/test').Page) {
    await page.goto('/');
    await page.getByRole('button', { name: '账号菜单', exact: true }).click();
    await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: 'Agent 接入', exact: true }).click();
}
async function unavailable(page: import('@playwright/test').Page) {
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
        document.execCommand = () => false;
    });
}
test('HTTP 环境使用兼容复制，并真正写入剪贴板', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.addInitScript(() => {
        const clipboard = navigator.clipboard;
        (window as any).readCopiedText = () => clipboard.readText();
        Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    });
    await settings(page);
    await page.getByRole('button', { name: '复制给 Agent 的安装指令', exact: true }).click();
    await expect(page.getByText('已复制', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).readCopiedText())).toContain('/api/agent/kit/manifest.json');
    await expect(page.getByRole('button', { name: '复制给 Agent 的安装指令', exact: true })).toBeFocused();
});
test('所有复制方式被拒绝时展示完整文本，选中并支持取消', async ({ page }) => {
    await unavailable(page); await settings(page);
    await page.getByRole('button', { name: '复制给 Agent 的安装指令', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '手动复制', exact: true });
    const text = dialog.getByRole('textbox', { name: '待复制内容' });
    await expect(text).toBeFocused();
    expect(await text.inputValue()).toContain('/api/agent/kit/manifest.json');
    expect(await text.inputValue()).toContain('不申请控制权');
    expect(await text.evaluate((element: HTMLTextAreaElement) => element.selectionStart === 0 && element.selectionEnd === element.value.length)).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('已复制', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible();
});
test('手动复制密钥只有明确确认后才解除未复制保护', async ({ page }) => {
    await unavailable(page); await settings(page);
    await page.getByRole('button', { name: '创建凭据', exact: true }).click();
    await page.getByLabel('凭据名称').fill('Clipboard regression');
    await page.getByRole('checkbox', { name: /workspace.read/ }).check();
    await page.getByRole('button', { name: '生成凭据', exact: true }).click();
    await page.getByRole('button', { name: '复制密钥', exact: true }).click();
    await page.getByRole('dialog', { name: '手动复制', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '关闭设置？' })).toContainText('密钥尚未复制');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '复制密钥', exact: true }).click();
    await page.getByRole('dialog', { name: '手动复制', exact: true }).getByRole('button', { name: '我已复制', exact: true }).click();
    await expect(page.locator('.settings-secret button')).toHaveText('已复制');
    await page.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '设置', exact: true })).toHaveCount(0);
});
