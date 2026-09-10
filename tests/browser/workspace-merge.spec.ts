import { test, expect, type Page } from '@playwright/test';

async function login(page: Page, username: string) {
    await page.goto('/');
    await page.getByLabel('账号', { exact: true }).fill(username);
    await page.getByLabel('密码', { exact: true }).fill('e2e-password-123');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByLabel('页面标题')).toBeVisible();
}

async function post(page: Page, path: string, data: object) {
    const response = await page.request.post('/api' + path, { headers: { 'x-workbench-client': 'test' }, data });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
}

async function publish(page: Page) {
    const preview = await (await page.request.get('/api/publish/preview')).json();
    return post(page, '/publish', { requestId: crypto.randomUUID(), head: preview.head, main: preview.main, title: '合并回归验证', description: '' });
}

test('删除字符串冲突的提示不会进入自定义值，仍可明确保留删除', async ({ page, browser }) => {
    const publisherContext = await browser.newContext();
    const publisher = await publisherContext.newPage();
    try {
        await login(page, 'designer');
        await login(publisher, 'developer');
        const preview = await (await publisher.request.get('/api/publish/preview')).json();
        await post(publisher, '/workspace/refresh', { requestId: crypto.randomUUID(), head: preview.head, main: preview.main, resolutions: {} });
        const entity = { id: 'deleted-string-doc', kind: 'object', title: '删除字符串验证', path: '设计/deleted-string.md', collection: null, fields: { note: '原始说明' }, body: '' };
        await post(publisher, '/workspace/operations', { requestId: crypto.randomUUID(), operations: [{ type: 'put', entity, expected: null }] });
        await publish(publisher);
        const baseline = await (await page.request.get('/api/publish/preview')).json();
        await post(page, '/workspace/refresh', { requestId: crypto.randomUUID(), head: baseline.head, main: baseline.main, resolutions: {} });
        const personalEntity = (await (await page.request.get('/api/workspace')).json()).tree[entity.id];
        const formalEntity = (await (await publisher.request.get('/api/workspace')).json()).tree[entity.id];
        await post(page, '/workspace/operations', { requestId: crypto.randomUUID(), operations: [{ type: 'put', entity: { ...personalEntity, fields: {} }, expected: personalEntity }] });
        await post(publisher, '/workspace/operations', { requestId: crypto.randomUUID(), operations: [{ type: 'put', entity: { ...formalEntity, fields: { note: '团队说明' } }, expected: formalEntity }] });
        await publish(publisher);
        await page.locator('.revision-bar').getByRole('button', { name: '合入最新正式设计' }).click();
        const dialog = page.getByRole('dialog', { name: '合入最新正式设计', exact: true });
        const input = dialog.getByLabel('自定义合并结果', { exact: false });
        const confirm = dialog.getByRole('button', { name: '确认自定义结果', exact: true });
        await expect(input).toHaveValue('');
        await expect(confirm).toBeDisabled();
        await expect(dialog.locator('.merge-comparison')).toContainText('（不存在 / 已删除）');
        await dialog.getByRole('button', { name: '采用正式内容', exact: true }).click();
        await expect(input).toHaveValue('团队说明');
        await dialog.getByRole('button', { name: '采用我的内容', exact: true }).click();
        await expect(input).toHaveValue('');
        await expect(confirm).toBeDisabled();
        await input.fill('明确自定义');
        await expect(confirm).toBeEnabled();
        await confirm.click();
        await dialog.getByRole('button', { name: '采用我的内容', exact: true }).click();
        await dialog.getByRole('button', { name: '确认合并到我的草稿' }).click();
        await expect(dialog).toHaveCount(0);
        const result = await (await page.request.get('/api/workspace')).json();
        expect(result.tree[entity.id].fields).not.toHaveProperty('note');
    } finally { await publisherContext.close(); }
});

test('双账号实时警示、独立合并、逐块编辑、并发保护与窄屏布局', async ({ page, browser }, testInfo) => {
    test.setTimeout(120000);
    const publisherContext = await browser.newContext();
    const publisher = await publisherContext.newPage();
    try {
        await login(page, 'developer');
        await login(publisher, 'designer');
        const entity = { id: 'merge-browser-doc', kind: 'object', title: '合并验证文档', path: '设计/merge-browser.md', collection: null, fields: {}, body: '# 合并验证\n\n共同段落\n\n稳定一\n\n稳定二\n\n末尾\n' };
        await post(publisher, '/workspace/operations', { requestId: crypto.randomUUID(), operations: [{ type: 'put', entity, expected: null }] });
        await publish(publisher);
        const bar = page.locator('.revision-bar');
        await expect(bar).toHaveClass(/revision-behind/);
        await expect(bar.getByRole('status')).toHaveText(/个人草稿落后/);
        await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('behind.png') });
        await bar.getByRole('button', { name: '合入最新正式设计' }).click();
        const dialog = page.getByRole('dialog', { name: '合入最新正式设计', exact: true });
        await expect(dialog).toBeVisible();
        await dialog.getByText('查看 Agent 指令', { exact: true }).click();
        await expect(dialog.locator('.merge-agent-tip details p')).toContainText('references/publishing.md');
        await expect(dialog.locator('.merge-agent-tip details p')).toContainText('不要重读无关全文');
        await expect(dialog.locator('.merge-agent-tip details p')).not.toContainText('design_preview');
        await expect(dialog.locator('.merge-agent-tip details p')).not.toContainText('workspace_refresh');
        await dialog.getByText('查看 Agent 指令', { exact: true }).click();
        await expect(page.getByRole('dialog', { name: '发布正式设计' })).toHaveCount(0);
        await expect(dialog.getByText('没有未解决冲突')).toBeVisible();
        await dialog.getByRole('button', { name: '确认合并到我的草稿' }).click();
        await expect(dialog).toHaveCount(0);
        await expect(bar).not.toHaveClass(/revision-behind/);

        await page.locator('.toast .icon').click();
        const baseEntity = (await (await page.request.get('/api/workspace')).json()).tree[entity.id];
        const publisherEntity = (await (await publisher.request.get('/api/workspace')).json()).tree[entity.id];
        const ours = { ...baseEntity, title: '我的合并标题', body: baseEntity.body.replace('共同段落', '我的段落').replace('末尾', '我的末尾') };
        const theirs = { ...publisherEntity, title: '团队合并标题', body: publisherEntity.body.replace('共同段落', '团队段落') + '\n团队追加\n' };
        await post(page, '/workspace/operations', { requestId: crypto.randomUUID(), operations: [{ type: 'put', entity: ours, expected: baseEntity }] });
        await post(publisher, '/workspace/operations', { requestId: crypto.randomUUID(), operations: [{ type: 'put', entity: theirs, expected: publisherEntity }] });
        const publication = await publish(publisher);
        await expect(bar).toHaveClass(/revision-behind/);
        await page.getByRole('button', { name: '发布变更', exact: true }).click();
        const release = page.getByRole('dialog', { name: '发布正式设计', exact: true });
        await release.getByLabel('变更标题').fill('保留我的发布说明');
        await release.getByRole('button', { name: '合入最新正式设计', exact: true }).click();
        await expect(dialog.getByRole('navigation', { name: '合并冲突列表' })).toBeVisible();
        await dialog.getByRole('button', { name: '取消', exact: true }).click();
        await expect(release.getByLabel('变更标题')).toHaveValue('保留我的发布说明');
        await release.getByRole('button', { name: '关闭', exact: true }).click();
        await expect(bar).toHaveClass(/revision-behind/);
        await bar.getByRole('button', { name: '合入最新正式设计' }).click();
        await expect(dialog.getByRole('navigation', { name: '合并冲突列表' })).toBeVisible();
        const submit = dialog.getByRole('button', { name: '确认合并到我的草稿' });
        await expect(submit).toBeDisabled();
        const conflicts = dialog.getByRole('navigation', { name: '合并冲突列表' });
        await conflicts.getByRole('button').filter({ has: page.getByText('标题', { exact: true }) }).click();
        await dialog.getByLabel('自定义合并结果', { exact: false }).fill('合并后的标题');
        await dialog.getByRole('button', { name: '确认自定义结果' }).click();
        await conflicts.getByRole('button').filter({ hasText: '正文' }).click();
        await expect(dialog.getByRole('heading', { name: '共同基线', exact: true }).first()).toBeVisible();
        await dialog.getByLabel('此块合并结果').first().fill('综合双方意图的段落');
        await dialog.getByRole('button', { name: '确认此块', exact: true }).first().click();
        await expect(submit).toBeDisabled();
        await dialog.getByLabel('此块合并结果').nth(1).fill('我的末尾\n\n团队追加');
        await dialog.getByRole('button', { name: '确认此块', exact: true }).click();
        await expect(submit).toBeEnabled();
        await expect.poll(() => dialog.evaluate(element => element.clientWidth)).toBeGreaterThan(1000);
        await dialog.locator('.merge-editors').evaluate(element => { element.scrollTop = 0; });
        await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('merge-desktop.png') });
        await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
        await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('merge-dark.png') });
        await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
        await page.setViewportSize({ width: 390, height: 844 });
        await expect.poll(() => dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('merge-mobile.png') });
        await page.setViewportSize({ width: 1440, height: 1000 });

        const current = (await (await page.request.get('/api/workspace')).json()).tree[entity.id];
        const changed = { ...current, fields: {}, body: current.body + '\n新的个人编辑\n' };
        await post(page, '/workspace/operations', { requestId: crypto.randomUUID(), operations: [{ type: 'put', entity: changed, expected: current }] });
        await expect(dialog.getByRole('alert')).toContainText('当前结果不能提交');
        await expect(submit).toBeDisabled();
        await dialog.getByRole('button', { name: '重新检查版本' }).click();
        await expect(dialog.getByRole('alert')).toHaveCount(0);
        await conflicts.getByRole('button').filter({ has: page.getByText('标题', { exact: true }) }).click();
        await dialog.getByRole('button', { name: '采用我的内容', exact: true }).click();
        await conflicts.getByRole('button').filter({ hasText: '正文' }).click();
        await dialog.locator('.merge-block').first().getByRole('button', { name: '采用正式内容', exact: true }).click();
        await dialog.getByLabel('此块合并结果').nth(1).fill('我的末尾\n\n团队追加\n\n新的个人编辑');
        await dialog.getByRole('button', { name: '确认此块', exact: true }).click();
        await expect(submit).toBeEnabled();
        await submit.click();
        await expect(dialog).toHaveCount(0);
        await expect(bar).not.toHaveClass(/revision-behind/);
        const snapshot = await (await page.request.get('/api/workspace')).json();
        expect(snapshot.workspace.base).toBe(publication.revision);
        expect(snapshot.main).toBe(publication.revision);
        expect(snapshot.tree[entity.id].title).toBe(ours.title);
        expect(snapshot.tree[entity.id].body).toContain('团队段落');
        expect(snapshot.tree[entity.id].body).toContain('我的末尾');
    } finally { await publisherContext.close(); }
});
