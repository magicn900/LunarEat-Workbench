// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { copyText, registerManualCopy } from '../src/web/clipboard';
let unregister: (() => void) | undefined;
afterEach(() => { unregister?.(); unregister = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
function setup(native?: () => Promise<void>, legacy = false) {
    vi.stubGlobal('navigator', { clipboard: native ? { writeText: native } : undefined });
    const command = vi.fn(() => legacy);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: command });
    const manual = vi.fn(async () => true);
    unregister = registerManualCopy(manual);
    return { command, manual };
}
it('原生复制成功时不调用兼容或手动复制', async () => {
    const native = vi.fn(async () => {});
    const { command, manual } = setup(native);
    expect(await copyText('sample')).toBe(true);
    expect(native).toHaveBeenCalledWith('sample');
    expect(command).not.toHaveBeenCalled(); expect(manual).not.toHaveBeenCalled();
});
it('原生复制被拒绝后使用兼容复制，恢复焦点与选择并移除临时文本', async () => {
    const { command, manual } = setup(async () => { throw new Error('denied'); }, true);
    const input = document.createElement('input'); document.body.append(input);
    input.value = 'previous'; input.focus(); input.setSelectionRange(1, 4);
    expect(await copyText('sample')).toBe(true);
    expect(command).toHaveBeenCalledWith('copy'); expect(manual).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input); expect(input.selectionStart).toBe(1); expect(input.selectionEnd).toBe(4);
    expect(document.querySelector('textarea')).toBeNull();
});
it('兼容复制失败后保留手动复制的取消结果', async () => {
    const { manual } = setup(); manual.mockResolvedValue(false);
    expect(await copyText('sample')).toBe(false); expect(manual).toHaveBeenCalledWith('sample');
    expect(document.querySelector('textarea')).toBeNull();
});
it('兼容复制抛异常时仍能手动确认', async () => {
    const { command, manual } = setup(); command.mockImplementation(() => { throw new Error('denied'); });
    expect(await copyText('sample')).toBe(true); expect(manual).toHaveBeenCalledOnce();
});
it('账号卸载后，未完成的原生请求不能弹出旧内容', async () => {
    let reject!: (error: Error) => void;
    const { command, manual } = setup(() => new Promise<void>((_, fail) => { reject = fail; }));
    const result = copyText('sample'); unregister?.(); reject(new Error('denied'));
    expect(await result).toBe(false); expect(command).not.toHaveBeenCalled(); expect(manual).not.toHaveBeenCalled();
});
it('没有手动复制宿主时不假报成功', async () => {
    setup(); unregister?.(); expect(await copyText('sample')).toBe(false);
});
