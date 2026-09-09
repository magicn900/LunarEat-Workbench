import type { CollectionView, DesignObject, Field, Tree } from './model';
export type ViewFilter = { key: string; operator: 'contains'|'equals'|'startsWith'|'empty'|'notEmpty'|'gt'|'gte'|'lt'|'lte'|'between'|'in'|'today'|'last7days'; value?: string|number|boolean|(string|number|boolean)[] };
export const filterOperators: Record<Field['type'], ViewFilter['operator'][]> = {
    text: ['in','contains','equals','startsWith','empty','notEmpty'], reference: ['contains','equals','in','empty','notEmpty'],
    number: ['equals','gt','gte','lt','lte','between','in','empty','notEmpty'], boolean: ['equals','empty','notEmpty'],
    date: ['equals','gt','gte','lt','lte','between','today','last7days','empty','notEmpty'], select: ['in','equals','empty','notEmpty'], multi: ['in','empty','notEmpty']
};
export function viewFilters(view: CollectionView): ViewFilter[] { return view.filters ?? (view.filter ? [{ key: view.filter.key, operator: 'contains', value: view.filter.value }] : []); }
export function fieldValue(row: DesignObject, key: string) { return key === 'title' ? row.title : row.fields[key]; }
export function displayValue(value: unknown, field?: Field, tree?: Tree): string { return value == null || value === '' ? '未设置' : Array.isArray(value) ? value.map(item => displayValue(item, field, tree)).join('、') : field?.type === 'reference' ? tree?.[String(value)]?.title || String(value) : typeof value === 'boolean' ? value ? '是' : '否' : String(value); }
export function matchesFilter(value: unknown, filter: ViewFilter, field?: Field, tree?: Tree, now = new Date()): boolean {
    const empty = value == null || value === '' || Array.isArray(value) && !value.length;
    const expected = filter.value;
    if (filter.operator === 'empty') return empty;
    if (filter.operator === 'notEmpty') return !empty;
    if (empty) return false;
    if (filter.operator === 'in') return Array.isArray(expected) && (Array.isArray(value) ? value.some(item => expected.includes(item)) : expected.includes(value as string|number|boolean));
    if (filter.operator === 'equals') return value === expected;
    if (filter.operator === 'contains' || filter.operator === 'startsWith') {
        const text = displayValue(value, field, tree).toLocaleLowerCase();
        const query = String(expected ?? '').toLocaleLowerCase();
        return filter.operator === 'contains' ? text.includes(query) : text.startsWith(query);
    }
    const comparable = (item: unknown) => field?.type === 'date' ? Date.parse(String(item) + 'T00:00:00Z') : typeof item === 'number' ? item : NaN;
    const actual = comparable(value);
    if (filter.operator === 'today' || filter.operator === 'last7days') {
        const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
        return actual <= today && actual >= today - (filter.operator === 'today' ? 0 : 6 * 86400000);
    }
    if (filter.operator === 'between') return Array.isArray(expected) && actual >= comparable(expected[0]) && actual <= comparable(expected[1]);
    const limit = comparable(expected);
    return filter.operator === 'gt' ? actual > limit : filter.operator === 'gte' ? actual >= limit : filter.operator === 'lt' ? actual < limit : actual <= limit;
}
export function queryViewResult(tree: Tree, view: CollectionView, requestedPage = 1, now = new Date()) {
    const collection = tree[view.collection];
    const fields = collection?.kind === 'collection' ? collection.fields : [];
    const all = Object.values(tree).filter((entity): entity is DesignObject => entity.kind === 'object' && entity.collection === view.collection);
    const filters = viewFilters(view);
    const search = (view.search || '').trim().toLocaleLowerCase();
    const filtered = all.filter(row => filters.every(filter => matchesFilter(fieldValue(row, filter.key), filter, fields.find(field => field.key === filter.key), tree, now)) && (!search || view.columns.some(key => displayValue(fieldValue(row, key), fields.find(field => field.key === key), tree).toLocaleLowerCase().includes(search))));
    filtered.sort((left, right) => {
        let order = 0;
        if (view.sort) {
            const first = fieldValue(left, view.sort.key), second = fieldValue(right, view.sort.key);
            order = first == null ? second == null ? 0 : 1 : second == null ? -1 : typeof first === 'number' && typeof second === 'number' ? first - second : displayValue(first, fields.find(field => field.key === view.sort!.key), tree).localeCompare(displayValue(second, fields.find(field => field.key === view.sort!.key), tree), 'zh-CN');
            if (view.sort.descending) order *= -1;
        }
        return order || left.id.localeCompare(right.id, 'en');
    });
    const pageSize = view.pagination?.pageSize || null;
    const pageCount = pageSize ? Math.max(1, Math.ceil(filtered.length / pageSize)) : 1;
    const page = Math.max(1, Math.min(pageCount, Math.trunc(requestedPage) || 1));
    return { rows: pageSize ? filtered.slice((page - 1) * pageSize, page * pageSize) : filtered, totalCount: all.length, filteredCount: filtered.length, page, pageCount, pageSize };
}
