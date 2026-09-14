import { expect, test, type Page } from '@playwright/test';
const headers = { 'x-workbench-client': 'test' };
async function setup(page: Page, body: string) {
    expect((await page.request.post('/api/login', { headers, data: { username: 'designer', password: 'e2e-password-123' } })).ok()).toBe(true);
    const identity = await (await page.request.get('/api/identity')).json();
    await page.request.post('/api/account/preferences', { headers, data: { ...identity.preferences, language: 'zh-CN', shortcuts: {} } });
    await page.goto('/'); await expect(page.locator('.milkdown .editor')).toBeVisible();
    const id = crypto.randomUUID();
    const entity = { id, kind: 'object', title: id, path: '性能测试/' + id + '.md', collection: null, fields: {}, body };
    expect((await page.request.post('/api/workspace/operations', { headers, data: { requestId: crypto.randomUUID(), operations: [{ type: 'put', expected: null, entity }] } })).ok()).toBe(true);
    await page.keyboard.press('Control+k'); await page.getByRole('textbox', { name: '搜索命令与页面' }).fill(id);
    await page.getByRole('button', { name: '打开：' + id, exact: true }).click();
    await expect(page.getByLabel('页面标题')).toHaveValue(id); await expect(page.locator('.milkdown .editor')).toBeVisible();
    return id;
}
async function backup(page: Page, id: string) {
    return page.evaluate(id => Object.keys(localStorage).filter(key => key.startsWith('draft:') && key.endsWith(':' + id)).map(key => localStorage.getItem(key)).join(''), id);
}
test('长文档移动光标不写恢复副本，未确认输入在 pagehide 时立即保存', async ({ page }) => {
    const id = await setup(page, Array.from({ length: 500 }, (_, index) => 'Paragraph ' + index + ': ordinary design text with **emphasis**, numbers and a short description.').join('\n\n'));
    await page.evaluate(() => {
        const original = Storage.prototype.setItem;
        (window as any).backupWrites = 0;
        Storage.prototype.setItem = function(key, value) { if (key.startsWith('draft:')) (window as any).backupWrites++; original.call(this, key, value); };
    });
    const editor = page.locator('.milkdown .editor'); await editor.click(); await page.keyboard.press('Control+End');
    for (let index = 0; index < 20; index++) await page.keyboard.press(index % 2 ? 'ArrowRight' : 'ArrowLeft');
    expect(await page.evaluate(() => (window as any).backupWrites)).toBe(0);
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/documents/' + id + '/steps', async route => { await gate; await route.continue(); });
    try {
        await page.keyboard.insertText('LATEST-UNCONFIRMED');
        await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
        expect(await backup(page, id)).toContain('LATEST-UNCONFIRMED');
    } finally { release(); }
    await expect.poll(() => backup(page, id)).toBe('');
    await page.reload(); await expect(page.locator('.milkdown .editor')).toContainText('LATEST-UNCONFIRMED');
    await expect(page.locator('.recovery')).toHaveCount(0);
});
test('短暂同步失败保留富文本和最新输入，重试后自动保存', async ({ page }) => {
    const id = await setup(page, 'original');
    await page.route('**/api/documents/' + id + '/steps', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '测试同步故障', requestId: 'performance-recovery' }) }));
    await page.locator('.milkdown .editor').click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('FAILURE-RECOVERY');
    await expect(page.locator('.document-sync-notice')).toBeVisible();
    await expect(page.locator('.milkdown .editor')).toContainText('FAILURE-RECOVERY');
    await expect(page.getByRole('textbox', { name: 'Markdown 源码', exact: true })).toHaveCount(0);
    expect(await backup(page, id)).toContain('FAILURE-RECOVERY');
    await page.keyboard.insertText('-CONTINUED');
    await page.unroute('**/api/documents/' + id + '/steps');
    await page.getByRole('button', { name: '重试同步', exact: true }).click();
    await expect.poll(async () => (await (await page.request.get('/api/documents/' + id + '/source')).json()).body).toContain('FAILURE-RECOVERY-CONTINUED');
    await expect(page.locator('.document-sync-notice')).toHaveCount(0);
    await expect.poll(() => backup(page, id)).toBe('');
});
test('暂时服务故障无需人工干预，自动重试原保存请求', async ({ page }) => {
    const id = await setup(page, 'original');
    const requests: string[] = [];
    await page.route('**/api/documents/' + id + '/steps', async route => {
        requests.push(route.request().postDataJSON().requestId);
        if (requests.length === 1) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary failure' }) });
        else await route.continue();
    });
    const editor = page.locator('.milkdown .editor');
    await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('AUTO-RETRY');
    await expect.poll(async () => (await (await page.request.get('/api/documents/' + id + '/source')).json()).body).toBe('originalAUTO-RETRY');
    expect(requests).toHaveLength(2);
    expect(requests[1]).toBe(requests[0]);
    await expect(editor).toHaveText('originalAUTO-RETRY');
    await expect(page.locator('.document-sync-notice')).toHaveCount(0);
});
test('保存成功后旧拉取响应晚到，不退出富文本或要求核对副本', async ({ page }) => {
    const id = await setup(page, 'original');
    let release: () => void = () => {};
    let captured: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { captured = resolve; });
    await page.route('**/api/documents/' + id + '?since=*', async route => {
        const response = await route.fetch();
        captured();
        await gate;
        await route.fulfill({ response });
    });
    const editor = page.locator('.milkdown .editor');
    await editor.dispatchEvent('compositionend');
    await ready;
    try {
        await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('NEWEST');
        await expect.poll(async () => (await (await page.request.get('/api/documents/' + id + '/source')).json()).body).toContain('NEWEST');
        await expect.poll(() => backup(page, id)).toBe('');
    } finally { release(); }
    await page.unrouteAll({ behavior: 'wait' });
    await expect(editor).toContainText('NEWEST');
    await expect(page.getByRole('textbox', { name: 'Markdown 源码', exact: true })).toHaveCount(0);
    await expect(page.locator('.recovery')).toHaveCount(0);
    await page.keyboard.insertText('-CONTINUE');
    await expect.poll(async () => (await (await page.request.get('/api/documents/' + id + '/source')).json()).body).toContain('NEWEST-CONTINUE');
});
test('增量记录缺失保留当前编辑内容，重新拉取后不重复写入', async ({ page }) => {
    const id = await setup(page, 'original');
    await page.route('**/api/documents/' + id + '?since=*', async route => {
        const response = await route.fetch();
        const result = await response.json();
        result.steps = []; result.clientIds = [];
        await route.fulfill({ response, json: result });
    });
    await page.route('**/api/documents/' + id + '/steps', async route => {
        const response = await route.fetch();
        const result = await response.json();
        result.document.steps = []; result.document.clientIds = [];
        await route.fulfill({ response, json: result });
    }, { times: 1 });
    const editor = page.locator('.milkdown .editor');
    await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('KEEP-ME');
    await expect(page.locator('.document-sync-notice')).toBeVisible();
    await expect(editor).toContainText('KEEP-ME');
    await expect(page.locator('.recovery')).toHaveCount(0);
    await page.keyboard.insertText('-AFTER-GAP');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载当前正文', exact: true }).click();
    const stream = await (await download).createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toContain('KEEP-ME-AFTER-GAP');
    await page.unroute('**/api/documents/' + id + '?since=*');
    await page.getByRole('button', { name: '重试同步', exact: true }).click();
    await expect.poll(async () => (await (await page.request.get('/api/documents/' + id + '/source')).json()).body).toBe('originalKEEP-ME-AFTER-GAP');
    await expect(page.locator('.document-sync-notice')).toHaveCount(0);
});
test('远端删除覆盖未保存输入时保留当前正文，不静默丢字或覆盖远端', async ({ page }) => {
    const id = await setup(page, 'original');
    const initial = await (await page.request.get('/api/documents/' + id)).json();
    await page.route('**/api/documents/' + id + '/steps', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'offline' }) }));
    const editor = page.locator('.milkdown .editor');
    await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('LOCAL');
    await expect(page.locator('.document-sync-notice')).toBeVisible();
    const response = await page.request.post('/api/documents/' + id + '/steps', { headers, data: {
        requestId: crypto.randomUUID(), schemaVersion: initial.schemaVersion, version: initial.version,
        steps: [{ stepType: 'replace', from: 0, to: 10, slice: { content: [{ type: 'paragraph' }] } }],
        clientId: 'other-editor', groupId: crypto.randomUUID()
    } });
    expect(response.ok()).toBe(true);
    const remoteBody = (await response.json()).document.body;
    await page.getByRole('button', { name: '重试同步', exact: true }).click();
    await expect(page.locator('.document-sync-notice')).toContainText('另一处修改与当前输入冲突');
    await expect(editor).toHaveText('originalLOCAL');
    expect((await (await page.request.get('/api/documents/' + id + '/source')).json()).body).toBe(remoteBody);
    expect(remoteBody).not.toContain('LOCAL');
    expect(await backup(page, id)).toContain('originalLOCAL');
    await expect(page.locator('.recovery')).toHaveCount(0);
});
test('公式切换只展开当前预览，滚动定位按帧合并', async ({ page }) => {
    await setup(page, Array.from({ length: 100 }, () => '$x+y$').join('\n\n'));
    const formulas = page.locator('.milkdown .editor [data-math]');
    await expect(formulas).toHaveCount(100);
    await formulas.first().locator('.math-rendered').click(); await expect(page.locator('.math-preview .katex')).toBeVisible();
    await formulas.nth(1).locator('.math-rendered').click(); await expect(formulas.nth(1)).toHaveClass(/math-editing/);
    await expect(formulas.first()).not.toHaveClass(/math-editing/); await expect(page.locator('.math-preview')).toHaveCount(1);
    const reads = await page.evaluate(async () => {
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const node = document.querySelector<HTMLElement>('.math-editing')!;
        const original = node.getBoundingClientRect.bind(node); let count = 0;
        node.getBoundingClientRect = () => { count++; return original(); };
        for (let index = 0; index < 30; index++) window.dispatchEvent(new Event('scroll'));
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); node.getBoundingClientRect = original; return count;
    });
    expect(reads).toBe(1);
    await page.keyboard.press('Escape'); await expect(page.locator('.math-preview')).toHaveCount(0);
});
