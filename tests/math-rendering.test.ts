// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mathPreviewLimits } from '../src/shared/mathLimits';
type Message = { id: number; source: string; display: boolean };
class TestWorker {
    static instances: TestWorker[] = [];
    messages: Message[] = [];
    onmessage: ((event: { data: { id: number; html: string } }) => void) | null = null;
    onerror: ((event: { preventDefault: () => void }) => void) | null = null;
    terminate = vi.fn();
    constructor() { TestWorker.instances.push(this); }
    postMessage(message: Message) { this.messages.push(message); }
    finish(html = '<span>formula</span>') { this.onmessage?.({ data: { id: this.messages.at(-1)!.id, html } }); }
}
let renderMath: typeof import('../src/web/mathRendering')['renderMath'];
beforeEach(async () => {
    vi.resetModules(); vi.useFakeTimers(); TestWorker.instances = []; vi.stubGlobal('Worker', TestWorker);
    ({ renderMath } = await import('../src/web/mathRendering'));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('正文与旁侧预览共享进行中的任务，完成后共享缓存', () => {
    const first = document.createElement('span'), second = document.createElement('span');
    renderMath(first, 'x+y', false); renderMath(second, 'x+y', false);
    const worker = TestWorker.instances[0]; expect(worker.messages).toHaveLength(1);
    worker.finish(); expect(first.innerHTML).toBe(second.innerHTML);
    renderMath(document.createElement('span'), 'x+y', false); expect(worker.messages).toHaveLength(1);
});
it('取消一个预览不影响其他订阅者，全数取消的排队任务不再执行', () => {
    const first = document.createElement('span'), second = document.createElement('span');
    const cancel = renderMath(first, 'shared', false); renderMath(second, 'shared', false); cancel();
    const removeQueued = renderMath(document.createElement('span'), 'queued', false); removeQueued();
    const worker = TestWorker.instances[0]; worker.finish();
    expect(first.textContent).toBe('shared'); expect(second.innerHTML).toContain('<span>'); expect(worker.messages).toHaveLength(1);
    renderMath(document.createElement('span'), 'queued', false); expect(worker.messages).toHaveLength(2); worker.finish();
});
it('大量相同公式只占一个任务，行内与块级公式仍分别计算', () => {
    const outputs = Array.from({ length: 150 }, () => document.createElement('span'));
    outputs.forEach(output => renderMath(output, 'same', false)); renderMath(document.createElement('span'), 'same', true);
    const worker = TestWorker.instances[0]; expect(worker.messages).toHaveLength(1); worker.finish();
    expect(outputs.every(output => output.innerHTML.includes('<span>'))).toBe(true);
    expect(worker.messages).toHaveLength(2); expect(worker.messages[1].display).toBe(true); worker.finish();
});
it('超时向全部订阅者报告错误，终止 Worker 后后续任务仍可运行', () => {
    const first = document.createElement('span'), second = document.createElement('span');
    renderMath(first, 'slow', false); renderMath(second, 'slow', false);
    renderMath(document.createElement('span'), 'next', false);
    vi.advanceTimersByTime(mathPreviewLimits.timeoutMs);
    expect(first.classList.contains('math-error')).toBe(true); expect(second.classList.contains('math-error')).toBe(true);
    expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce(); expect(TestWorker.instances).toHaveLength(2);
    TestWorker.instances[1].finish();
});
