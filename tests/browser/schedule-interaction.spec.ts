import { test, expect, type Page, type Locator } from '@playwright/test';
import { emptyTask, dateNumber, dateString, localToday, type ScheduledTask, type TaskFields } from '../../src/shared/schedule';
const headers = { 'x-workbench-client': 'test', 'x-project-id': 'demo' };
const today = dateNumber(localToday());
const day = (offset: number) => dateString(today + offset);
async function login(page: Page) {
    expect((await page.request.post('/api/login', { headers, data: { username: 'designer', password: 'e2e-password-123' } })).ok()).toBe(true);
    const snapshot = await (await page.request.get('/api/schedule', { headers })).json();
    return { designer: snapshot.members.find((member: any) => member.username === 'designer').id, developer: snapshot.members.find((member: any) => member.username === 'developer').id };
}
async function create(page: Page, fields: Partial<TaskFields>): Promise<ScheduledTask> {
    const response = await page.request.post('/api/schedule/tasks', { headers, data: { requestId: crypto.randomUUID(), version: 0, task: { ...emptyTask, title: 'Interaction', ...fields } } });
    expect(response.ok()).toBe(true); return response.json();
}
async function show(page: Page, scope: string) {
    await page.goto('/');
    await page.getByRole('navigation', { name: '项目共享', exact: true }).getByRole('button', { name: '任务排期', exact: true }).click();
    await page.getByRole('combobox', { name: '任务范围', exact: true }).selectOption(scope);
}
const normalRow = (page: Page, id: string) => page.locator('.schedule-row[data-context="false"][data-task-id="' + id + '"]');
async function stored(page: Page, id: string): Promise<ScheduledTask> {
    const snapshot = await (await page.request.get('/api/schedule', { headers })).json();
    return snapshot.tasks.find((task: ScheduledTask) => task.id === id);
}
async function beginDrag(page: Page, row: Locator, part: string, offset: number) {
    const cellWidth = (await row.locator('.schedule-track').boundingBox())!.width / 14;
    const bounds = (await row.locator(part).boundingBox())!;
    const origin = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    await page.mouse.move(origin.x, origin.y); await page.mouse.down();
    await page.mouse.move(origin.x + cellWidth * offset, origin.y, { steps: 8 });
}
test('按人分组保留跨负责人的父子树，暗色四种状态清晰可辨', async ({ page }) => {
    const owners = await login(page);
    const parent = await create(page, { title: '交互预览 · 可玩原型', ownerIds: [owners.designer], startDate: day(0), endDate: day(12), status: 'doing' });
    const children: ScheduledTask[] = [];
    for (const [index, status] of (['todo', 'doing', 'blocked', 'done'] as const).entries()) children.push(await create(page, { title: ['需求整理', '战斗事件接入', '召唤回归验证', '图标清单'][index], ownerIds: [owners.developer], parentId: parent.id, startDate: day(index), endDate: day(index + 4), status, blockedReason: status === 'blocked' ? '等待评审' : '' }));
    await show(page, parent.id);
    const developer = page.locator('.schedule-owner-group[data-owner-id="' + owners.developer + '"]');
    await expect(developer.locator('.schedule-row[data-task-id="' + parent.id + '"]')).toHaveAttribute('data-context', 'true');
    await expect(normalRow(page, children[0].id)).toHaveAttribute('data-depth', '1');
    await expect(page.getByText('整体负责', { exact: true })).toHaveCount(0);
    await developer.getByRole('button', { name: '收起子任务', exact: true }).click();
    await expect(normalRow(page, children[0].id)).toHaveCount(0);
    await developer.getByRole('button', { name: '展开子任务', exact: true }).click();
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await expect(page.locator('.schedule-row[data-context="false"] .schedule-bar.doing .schedule-bar-body').first()).toHaveCSS('color', 'rgb(213, 235, 255)');
    const colors = await page.locator('.schedule-row[data-context="false"] .schedule-bar').evaluateAll(elements => elements.map(element => ({ background: getComputedStyle(element).backgroundColor, text: getComputedStyle(element.querySelector('.schedule-bar-body')!).color })));
    expect(new Set(colors.map(color => color.background)).size).toBe(4);
    const luminance = (color: string) => { const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(value => { const channel = Number(value) / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4; }); return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722; };
    for (const color of colors) expect((luminance(color.text) + 0.05) / (luminance(color.background) + 0.05)).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: '.local-data/schedule-v2-people-dark.png', fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: '任务树', exact: true }).click();
    await expect(normalRow(page, children[0].id)).toHaveAttribute('data-depth', '1');
    await page.screenshot({ path: '.local-data/schedule-v2-tree-dark.png', fullPage: true, animations: 'disabled' });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.screenshot({ path: '.local-data/schedule-v2-tree-light.png', fullPage: true, animations: 'disabled' });
});
test('任务条平移、两端缩放、Esc取消、撤销和键盘改期都持久化且父子不联动', async ({ page }) => {
    const owners = await login(page);
    const parent = await create(page, { title: '拖动父任务', ownerIds: [owners.designer], startDate: day(0), endDate: day(10) });
    const child = await create(page, { title: '拖动子任务', ownerIds: [owners.designer], parentId: parent.id, startDate: day(2), endDate: day(6) });
    await show(page, parent.id);
    const row = normalRow(page, child.id);
    await beginDrag(page, row, '.schedule-bar-body', 2);
    await expect(page.locator('.schedule-interaction-status')).toContainText(day(4));
    await page.mouse.up();
    await expect.poll(async () => (await stored(page, child.id)).startDate).toBe(day(4));
    expect((await stored(page, child.id)).endDate).toBe(day(8));
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: '撤销改期', exact: true }).click();
    await expect.poll(async () => (await stored(page, child.id)).startDate).toBe(day(2));
    await beginDrag(page, row, '.schedule-resize.end', 2); await page.mouse.up();
    await expect.poll(async () => (await stored(page, child.id)).endDate).toBe(day(8));
    await beginDrag(page, row, '.schedule-resize.start', 1); await page.mouse.up();
    await expect.poll(async () => (await stored(page, child.id)).startDate).toBe(day(3));
    const beforeCancel = await stored(page, child.id);
    await beginDrag(page, row, '.schedule-bar-body', -1); await page.keyboard.press('Escape'); await page.mouse.up();
    await expect(page.locator('.schedule-interaction-status')).toContainText('已取消改期');
    expect(await stored(page, child.id)).toEqual(beforeCancel);
    await row.locator('.schedule-bar-body').press('ArrowRight');
    await expect.poll(async () => (await stored(page, child.id)).startDate).toBe(day(4));
    const beforeParent = await stored(page, child.id);
    await beginDrag(page, normalRow(page, parent.id), '.schedule-bar-body', 1); await page.mouse.up();
    await expect.poll(async () => (await stored(page, parent.id)).startDate).toBe(day(1));
    expect(await stored(page, child.id)).toEqual(beforeParent);
    await page.reload();
    await expect(page.getByRole('heading', { name: '任务排期', exact: true })).toBeVisible();
    expect((await stored(page, child.id)).startDate).toBe(day(4));
});
test('拖动期间出现并发修改或请求失败时，不覆盖新数据并恢复服务器日期', async ({ page }) => {
    const owners = await login(page);
    const task = await create(page, { title: '改期并发保护', ownerIds: [owners.designer], startDate: day(2), endDate: day(6) });
    await show(page, task.id);
    const row = normalRow(page, task.id);
    await beginDrag(page, row, '.schedule-bar-body', 1);
    const { id, version, created, updated, ...fields } = task;
    expect((await page.request.post('/api/schedule/tasks', { headers, data: { requestId: crypto.randomUUID(), id, version, task: { ...fields, description: '同伴的新说明' } } })).ok()).toBe(true);
    await page.mouse.up();
    await expect(page.getByRole('alert')).toContainText('任务已被他人修改');
    await expect(row.locator('.schedule-bar-body')).toHaveAttribute('aria-label', new RegExp(day(2) + ' — ' + day(6)));
    expect((await stored(page, task.id)).description).toBe('同伴的新说明');
    await page.route('**/api/schedule/tasks', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '模拟断网' }) }));
    await beginDrag(page, row, '.schedule-bar-body', 1); await page.mouse.up();
    await expect(page.getByRole('alert')).toContainText('改期未确认');
    await expect(row.locator('.schedule-bar-body')).toHaveAttribute('aria-label', new RegExp(day(2) + ' — ' + day(6)));
    expect((await stored(page, task.id)).startDate).toBe(day(2));
});
