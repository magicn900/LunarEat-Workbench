import { diffIndices } from 'node-diff3';
import { diffTrees, equal, type Difference, type Tree } from './model.js';
export type ReviewItem = Difference & { key: string; label: string; path: string; location: string[]; range?: { start: number; end: number; line: number }; };
export type DiscardTarget = { id: string; key?: string };
export const propertyLabels: Record<string, string> = { body: '正文', title: '名称', path: '文件位置', fields: '字段结构', collection: '所属集合', layout: '视图布局', columns: '显示字段', filter: '筛选条件', filters: '筛选条件', filterLogic: '条件组合', sort: '排序', search: '视图搜索', pagination: '分页设置', kind: '内容类型' };
export function reviewChanges(before: Tree, after: Tree): ReviewItem[] {
    return diffTrees(before, after).flatMap(change => {
        const entity = after[change.id] || before[change.id];
        const field = change.kind === '字段';
        const collectionId = entity.kind === 'object' ? entity.collection : null;
        const collections = collectionId ? [after[collectionId], before[collectionId]] : [];
        const label = field ? collections.flatMap(collection => collection?.kind === 'collection' ? collection.fields : []).find(item => item.key === change.property)?.label || change.property : propertyLabels[change.property] || change.property;
        const location = field ? ['fields', change.property] : [change.property];
        const item = { ...change, label, location, path: entity.path, key: JSON.stringify([change.id, location, change.kind]) };
        if (change.kind !== '正文') return [item];
        const oldLines = String(change.before ?? '').match(/[^\n]*\n|[^\n]+$/g) || [];
        const newLines = String(change.after ?? '').match(/[^\n]*\n|[^\n]+$/g) || [];
        return diffIndices(oldLines, newLines).map(region => {
            const [oldStart, oldCount] = region.buffer1, [newStart, newCount] = region.buffer2;
            const start = newLines.slice(0, newStart).join('').length;
            const replacement = oldLines.slice(oldStart, oldStart + oldCount).join('');
            const removed = newLines.slice(newStart, newStart + newCount).join('');
            return { ...item, key: JSON.stringify([change.id, 'body', oldStart, oldCount, newStart, newCount]), label: '正文 · 第 ' + (newStart + 1) + ' 行附近', before: replacement, after: removed, range: { start, end: start + removed.length, line: newStart + 1 } };
        });
    });
}
export function restoreTargets(base: Tree, current: Tree, targets: DiscardTarget[]): Tree {
    const result = structuredClone(current);
    const changes = reviewChanges(base, current);
    const whole = new Set(targets.filter(target => target.key === undefined).map(target => target.id));
    for (const id of whole) {
        if (equal(base[id], current[id])) throw Error('所选内容已没有待丢弃的修改');
        if (base[id]) result[id] = structuredClone(base[id]); else delete result[id];
    }
    const selected = targets.filter(target => !whole.has(target.id)).map(target => {
        const item = changes.find(item => item.id === target.id && item.key === target.key);
        if (!item) throw Error('差异已变化，请重新检查修改');
        return item;
    }).sort((left, right) => (right.range?.start || 0) - (left.range?.start || 0));
    for (const item of selected) {
        if (item.property === '对象') { if (base[item.id]) result[item.id] = structuredClone(base[item.id]); else delete result[item.id]; continue; }
        if (item.range) {
            const entity = result[item.id];
            if (entity?.kind !== 'object') throw Error('正文目标已不存在');
            entity.body = entity.body.slice(0, item.range.start) + item.before + entity.body.slice(item.range.end);
        } else {
            let previous: any = base[item.id], next: any = result[item.id];
            for (const part of item.location.slice(0, -1)) { previous = previous?.[part]; next = next[part]; }
            const key = item.location.at(-1)!;
            if (previous && Object.hasOwn(previous, key)) next[key] = structuredClone(previous[key]); else delete next[key];
        }
    }
    return result;
}

