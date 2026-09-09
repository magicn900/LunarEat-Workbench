import { test, expect } from '@playwright/test';

test('管理页面闭环：创建、授权、停用、审计及窄屏布局', async ({ page }) => {
    await page.goto('/admin');
    await page.getByLabel('账号', { exact: true }).fill('test-admin');
    await page.getByLabel('密码', { exact: true }).fill('e2e-password-123');
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page.getByRole('heading', { name: '让每个人拥有合适的权限' })).toBeVisible();
    await page.getByRole('button', { name: '创建账号', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('账号名称').fill('visual-member');
    await dialog.getByLabel('新密码').fill('visual-member-password');
    await dialog.getByRole('button', { name: '确认', exact: true }).click();
    const detail = page.getByRole('region', { name: '账号详情' });
    await expect(detail.getByRole('heading', { name: 'visual-member' })).toBeVisible();
    await detail.getByLabel('编辑自己的草稿').check();
    await expect(detail.getByLabel('查看草稿与正式设计')).toBeChecked();
    await detail.getByLabel('查看共享灵感池').check();
    await detail.getByRole('button', { name: '加入此项目' }).click();
    await expect(detail.getByRole('button', { name: '保存项目权限' })).toBeDisabled();
    await expect(detail.getByText('项目成员', { exact: true })).toBeVisible();
    await page.screenshot({ path: '.local-data/admin-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(detail.getByLabel('编辑自己的草稿')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.local-data/admin-mobile.png', fullPage: true });
    await detail.getByRole('button', { name: '停用账号', exact: true }).click();
    await dialog.getByRole('button', { name: '确认', exact: true }).click();
    await expect(detail.getByRole('button', { name: '启用账号' })).toBeVisible();
    await page.getByRole('button', { name: '操作记录', exact: true }).click();
    await expect(page.getByRole('heading', { name: /调整账号/ }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: /加入项目/ }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: /创建账号/ }).first()).toBeVisible();
});

test('普通账号直接访问管理页面显示无权限，而不是进入管理界面', async ({ page }) => {
    await page.goto('/admin');
    await page.getByLabel('账号', { exact: true }).fill('designer');
    await page.getByLabel('密码', { exact: true }).fill('e2e-password-123');
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page.getByRole('heading', { name: '此入口仅对平台管理员开放' })).toBeVisible();
    await expect(page.getByRole('button', { name: '创建账号' })).toHaveCount(0);
    await page.getByRole('button', { name: '切换账号', exact: true }).click();
    await expect(page.getByLabel('账号', { exact: true })).toBeVisible();
});

test('无项目管理员可以登录，不能停用最后一位管理员', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('账号', { exact: true }).fill('test-admin');
    await page.getByLabel('密码', { exact: true }).fill('e2e-password-123');
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page.getByRole('heading', { name: '管理平台，或加入项目开始策划' })).toBeVisible();
    await page.getByRole('link', { name: '进入平台管理', exact: true }).click();
    await page.getByRole('button', { name: 'test-admin 平台管理员' }).click();
    await page.getByRole('button', { name: '停用账号', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('至少一个可用');
});

test('只读成员可以浏览并生成只读 Agent 凭据，不能编辑或发布', async ({ page }) => {
    const headers = { 'x-workbench-client': 'test' };
    await page.request.post('/api/login', { headers, data: { username: 'test-admin', password: 'e2e-password-123' } });
    const created = await page.request.post('/api/admin/users', { headers, data: { username: 'readonly-browser', password: 'readonly-password' } });
    expect(created.ok()).toBe(true);
    const userId = (await created.json()).id;
    const permission = await page.request.post('/api/admin/member', { headers, data: { userId, projectId: 'demo', scopes: ['workspace.read'], expectedScopes: null } });
    expect(permission.ok()).toBe(true);
    await page.request.post('/api/login', { headers, data: { username: 'readonly-browser', password: 'readonly-password' } });
    await page.goto('/');
    await expect(page.locator('.ProseMirror').first()).toHaveAttribute('contenteditable', 'false');
    await expect(page.getByRole('button', { name: '发布变更' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '新建内容', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '账号菜单' }).click();
    await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: 'Agent 接入' }).click();
    await page.getByRole('button', { name: '创建凭据', exact: true }).click();
    await page.getByLabel('凭据名称').fill('Browser test agent');
    await page.getByRole('checkbox', { name: /workspace.read/ }).check();
    await expect(page.getByRole('checkbox', { name: /workspace.write/ })).toHaveCount(0);
    await page.getByRole('button', { name: '生成凭据', exact: true }).click();
    await expect(page.getByText('仅显示一次，请妥善保管')).toBeVisible();
});

test('灵感池专用成员无需设计读取权限，也能访问设置和授权 Agent', async ({ page }) => {
    const headers = { 'x-workbench-client': 'test' };
    await page.request.post('/api/login', { headers, data: { username: 'test-admin', password: 'e2e-password-123' } });
    const created = await page.request.post('/api/admin/users', { headers, data: { username: 'inspiration-browser', password: 'inspiration-password' } });
    expect(created.ok()).toBe(true);
    const userId = (await created.json()).id;
    expect((await page.request.post('/api/admin/member', { headers, data: { userId, projectId: 'demo', scopes: ['inspiration.read'], expectedScopes: null } })).ok()).toBe(true);
    await page.request.post('/api/login', { headers, data: { username: 'inspiration-browser', password: 'inspiration-password' } });
    await page.goto('/');
    await page.getByRole('button', { name: '打开灵感池', exact: true }).click();
    await expect(page.getByRole('heading', { name: '共享灵感池' })).toBeVisible();
    await expect(page.getByRole('button', { name: '记下灵感' })).toBeDisabled();
    await expect(page.locator('.ProseMirror')).toHaveCount(0);
    await page.getByRole('button', { name: '账号菜单' }).click();
    await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: 'Agent 接入' }).click();
    await page.getByRole('button', { name: '创建凭据', exact: true }).click();
    await page.getByLabel('凭据名称').fill('Browser test agent');
    await expect(page.getByRole('button', { name: '生成凭据' })).toBeDisabled();
    await page.getByRole('checkbox', { name: /inspiration.read/ }).check();
    await page.getByRole('button', { name: '生成凭据' }).click();
    await expect(page.getByText('仅显示一次，请妥善保管')).toBeVisible();
});
