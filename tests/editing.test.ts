import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../src/web/state', () => ({ api: vi.fn(), getSnapshot: () => null, reload: vi.fn(), notify: vi.fn() }));
import { afterEditing, flushEditing, hasPendingInput, registerBuffer } from '../src/web/editing';
beforeEach(() => vi.stubGlobal('window', new EventTarget()));
afterEach(() => vi.unstubAllGlobals());
it('连续视图操作在等待阶段也属于未保存输入，保存等待最后一次写入', async () => {
    let releaseFirst!: () => void, releaseSecond!: () => void;
    const first = new Promise<void>(resolve => { releaseFirst = resolve; });
    const second = new Promise<void>(resolve => { releaseSecond = resolve; });
    const writes: number[] = [];
    const initial = afterEditing(async () => { writes.push(1); await first; });
    const following = afterEditing(async () => { writes.push(2); await second; });
    let saved = false;
    const saving = flushEditing().then(() => { saved = true; });
    expect(hasPendingInput()).toBe(true);
    releaseFirst(); await initial; await Promise.resolve();
    expect(writes).toEqual([1, 2]); expect(saved).toBe(false); expect(hasPendingInput()).toBe(true);
    releaseSecond(); await following; await saving;
    expect(saved).toBe(true); expect(hasPendingInput()).toBe(false);
});
it('视图切换先提交已有字段输入，再执行操作', async () => {
    let dirty = true;
    const order: string[] = [];
    const unregister = registerBuffer('test-cell', { dirty: () => dirty, flush: async () => { order.push('cell'); dirty = false; } });
    try { await afterEditing(async () => { order.push('view'); }); expect(order).toEqual(['cell', 'view']); }
    finally { unregister(); }
    expect(hasPendingInput()).toBe(false);
});
it('非法未保存输入阻止视图切换，操作失败也释放自身追踪', async () => {
    const unregister = registerBuffer('test-invalid', { dirty: () => true, flush: async () => { throw Error('字段无效'); } });
    const action = vi.fn();
    try { await expect(afterEditing(action)).rejects.toThrow('字段无效'); expect(action).not.toHaveBeenCalled(); }
    finally { unregister(); }
    await expect(afterEditing(async () => { throw Error('保存冲突'); })).rejects.toThrow('保存冲突');
    expect(hasPendingInput()).toBe(false);
});

