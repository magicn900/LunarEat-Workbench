// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Schema } from '@milkdown/prose/model';
import { DocumentBackup } from '../src/web/DocumentBackup';
const schema = new Schema({ nodes: { doc: { content: 'text*' }, text: {} } });
const doc = (text: string) => schema.node('doc', null, schema.text(text));
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
it('连续输入只序列化最新正文，持续输入也每 250ms 保留一次副本', () => {
    const serialize = vi.fn(node => node.textContent), failure = vi.fn();
    const backup = new DocumentBackup('draft', serialize, failure);
    for (let index = 0; index < 10; index++) { backup.schedule(doc('text-' + index)); vi.advanceTimersByTime(50); }
    expect(serialize).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem('draft')).toBe('text-9'); expect(failure).not.toHaveBeenCalled();
});
it('同一文档版本只持久化一次，立即 flush 保存尚未到期的最新输入', () => {
    const serialize = vi.fn(node => node.textContent), backup = new DocumentBackup('draft', serialize, vi.fn());
    const first = doc('first'); backup.schedule(first); backup.flush();
    for (let index = 0; index < 100; index++) { backup.schedule(first); backup.flush(); }
    expect(serialize).toHaveBeenCalledTimes(1);
    backup.schedule(doc('latest')); backup.flush(); backup.cancel(); vi.runAllTimers();
    expect(localStorage.getItem('draft')).toBe('latest'); expect(serialize).toHaveBeenCalledTimes(2);
});
it('服务端确认后取消延迟备份，不会重新生成已经清除的恢复副本', () => {
    const serialize = vi.fn(node => node.textContent), backup = new DocumentBackup('draft', serialize, vi.fn());
    backup.schedule(doc('saved')); backup.clear(); vi.runAllTimers();
    expect(serialize).not.toHaveBeenCalled(); expect(localStorage.getItem('draft')).toBeNull();
});
it('取消待写版本并回到已备份版本时，不会落盘过期内容', () => {
    const backup = new DocumentBackup('draft', node => node.textContent, vi.fn());
    const first = doc('first'); backup.schedule(first); backup.flush();
    backup.schedule(doc('outdated')); backup.schedule(first); vi.runAllTimers();
    expect(localStorage.getItem('draft')).toBe('first');
});
it('存储失败可报告并重试，不将失败版本当成已持久化版本', () => {
    const failure = vi.fn(), backup = new DocumentBackup('draft', node => node.textContent, failure);
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw Error('quota'); });
    backup.schedule(doc('recoverable')); backup.flush(); expect(failure).toHaveBeenCalledTimes(1);
    backup.flush(); expect(write).toHaveBeenCalledTimes(2); expect(localStorage.getItem('draft')).toBe('recoverable');
});
