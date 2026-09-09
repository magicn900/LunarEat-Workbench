import { test, expect } from '@playwright/test';
test('普通工作台名称让位于项目，桌面和窄屏无品牌溢出', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle('工作台');
    await expect(page.getByRole('heading', { name: '登录工作台' })).toBeVisible();
    await expect(page.locator('.workspace-name')).toHaveText('工作台');
    await expect(page.locator('body')).not.toContainText('策页');
    await page.screenshot({path:'.local-data/identity-login.png'});
    await page.getByLabel('账号', { exact:true }).fill('designer');
    await page.getByLabel('密码', { exact:true }).fill('e2e-password-123');
    await page.getByRole('button', {name:'登录', exact:true}).click();
    await expect(page.locator('.workspace-project')).toBeVisible();
    await expect(page.locator('.workspace-caption')).toHaveText('工作台');
    await expect(page).toHaveTitle(/ · 工作台$/);
    await page.screenshot({path:'.local-data/identity-desktop.png'});
    await page.setViewportSize({width:390,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
