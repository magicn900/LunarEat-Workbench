import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from '../src/web/uuid';
afterEach(() => vi.unstubAllGlobals());
it('安全上下文使用原生 UUID', () => {
    const native = vi.fn(() => '11111111-1111-4111-8111-111111111111');
    vi.stubGlobal('crypto', { randomUUID: native });
    expect(randomUUID()).toBe('11111111-1111-4111-8111-111111111111');
    expect(native).toHaveBeenCalledOnce();
});
it('HTTP 上下文使用安全随机字节并设置 UUID 格式位', () => {
    const random = vi.fn((bytes: Uint8Array) => bytes.fill(255));
    vi.stubGlobal('crypto', { getRandomValues: random });
    expect(randomUUID()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(random).toHaveBeenCalledOnce();
    expect(random.mock.calls[0][0]).toHaveLength(16);
});
it('安全随机源不可用时拒绝退化为伪随机标识', () => {
    vi.stubGlobal('crypto', {});
    expect(() => randomUUID()).toThrow();
});
