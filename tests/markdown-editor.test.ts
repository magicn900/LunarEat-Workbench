// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ locked: false, api: vi.fn(), buffers: new Map<string, { dirty: () => boolean; flush: () => Promise<void> }>() }));
vi.mock('../src/web/state', () => ({ api: mocks.api, currentProject: () => 'project', getSnapshot: () => ({ actor: { userId: 'user' } }), reload: async () => {}, useSnapshot: () => null }));
vi.mock('../src/web/editing', () => ({ locked: () => mocks.locked, editingChanged: () => {}, registerBuffer: (id: string, buffer: any) => { mocks.buffers.set(id, buffer); return () => mocks.buffers.delete(id); } }));
import { MarkdownEditor } from '../src/web/MarkdownEditor';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(async () => {
    localStorage.clear(); mocks.locked = false;
    mocks.api.mockImplementation(async (_path, input) => ({ body: input?.body || 'original' }));
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root.render(createElement(MarkdownEditor, { id: 'page', reason: '', onClose: () => {} })); });
});
afterEach(() => { act(() => root.unmount()); container.remove(); mocks.api.mockReset(); vi.restoreAllMocks(); });
function type(value: string) {
    const input = container.querySelector('textarea')!;
    act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
it('控制权阻止 flush 后，恢复控制权仍能保存，不保留永久失败的 Promise', async () => {
    type('new text'); mocks.locked = true;
    await expect(mocks.buffers.get('markdown:page')!.flush()).rejects.toThrow();
    mocks.locked = false;
    await act(async () => { await mocks.buffers.get('markdown:page')!.flush(); });
    expect(mocks.api).toHaveBeenLastCalledWith('/documents/page/source', expect.objectContaining({ expected: 'original', body: 'new text' }));
    expect(mocks.buffers.get('markdown:page')!.dirty()).toBe(false);
});
it('本机存储配额不足时保留可编辑输入，并允许向服务端保存', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError'); });
    type('preserved input');
    expect(container.textContent).toContain('无法保存本机副本');
    await act(async () => { await mocks.buffers.get('markdown:page')!.flush(); });
    expect(mocks.api).toHaveBeenLastCalledWith('/documents/page/source', expect.objectContaining({ body: 'preserved input' }));
});
