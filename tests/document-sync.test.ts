import { expect, it } from 'vitest';
import { documentDelta } from '../src/web/documentSync';

it('忽略晚到的旧响应和已经确认的保存响应', () => {
    expect(documentDelta(5, { version: 3, steps: [], clientIds: [] }).kind).toBe('stale');
    expect(documentDelta(5, { version: 5, steps: [1], clientIds: ['self'] }).kind).toBe('stale');
});
it('拉取期间保存推进版本，只应用尚未接收的步骤及对应作者', () => {
    expect(documentDelta(5, { version: 7, steps: [4, 5, 6, 7], clientIds: ['self', 'self', 'other', 'other'] }))
        .toEqual({ kind: 'steps', steps: [6, 7], clientIds: ['other', 'other'] });
});
it('完整增量正常接收，真正缺失记录和协议损坏不自动覆盖正文', () => {
    expect(documentDelta(5, { version: 6, steps: [6], clientIds: ['self'] }).kind).toBe('steps');
    expect(documentDelta(5, { version: 7, steps: [7], clientIds: ['other'] }).kind).toBe('gap');
    expect(documentDelta(5, { version: 6, steps: [6], clientIds: [] }).kind).toBe('gap');
});
