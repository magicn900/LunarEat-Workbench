import { expect, it } from 'vitest';
import { reviewChanges, restoreTargets } from '../src/shared/review';
import type { DesignObject, Tree } from '../src/shared/model';
const document: DesignObject = { id: 'page', kind: 'object', path: 'page.md', title: '设计', body: '第一段\n\n第二段\n\n第三段', collection: null, fields: {} };
const base: Tree = { page: document };
it('空白差异与有效正文分开，按位置恢复片段而不替换重复文字', () => {
    const current = { page: { ...document, body: '第一段\n\n\n第二段\n\n第三段改进' } };
    const items = reviewChanges(base, current); expect(items).toHaveLength(2);
    const blank = items.find(item => String(item.after).trim() === '')!;
    const result = restoreTargets(base, current, [{ id: 'page', key: blank.key }]);
    expect((result.page as DesignObject).body).toBe('第一段\n\n第二段\n\n第三段改进'); expect(current.page.body).toContain('\n\n\n');
});
it('多个片段逆序恢复，保持末尾换行和精确空白', () => {
    const current = { page: { ...document, body: '第一段  \n\n第二段\n\n第三段\n' } };
    const items = reviewChanges(base, current);
    expect(restoreTargets(base, current, items.map(item => ({ id: item.id, key: item.key })))).toEqual(base);
});
it('字段名称来自所属集合，单项恢复不影响其他字段', () => {
    const collection = { id: 'set', kind: 'collection' as const, title: '集合', path: 'set.json', fields: [{ key: 'cost', label: '消耗', type: 'number' as const, required: false }] };
    const before: Tree = { set: collection, page: { ...document, collection: 'set', fields: { cost: 2 } } };
    const after: Tree = { ...before, page: { ...document, title: '改名', collection: 'set', fields: { cost: 3 } } };
    const item = reviewChanges(before, after).find(item => item.property === 'cost')!; expect(item.label).toBe('消耗');
    expect(restoreTargets(before, after, [{ id: 'page', key: item.key }]).page).toMatchObject({ title: '改名', fields: { cost: 2 } });
});
it('文件级取消新增及恢复删除，不操作传入快照', () => {
    expect(restoreTargets({}, base, [{ id: 'page' }])).toEqual({}); expect(restoreTargets(base, {}, [{ id: 'page' }])).toEqual(base);
    expect(() => restoreTargets(base, base, [{ id: 'page' }])).toThrow();
    expect(() => restoreTargets(base, { page: { ...document, title: '新名' } }, [{ id: 'page', key: '__proto__' }])).toThrow();
});

