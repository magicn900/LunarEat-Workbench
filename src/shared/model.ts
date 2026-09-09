import { z } from 'zod';
import YAML from 'yaml';
import { markdownReferences } from './markdownReferences.js';
import { mergeDiff3 } from 'node-diff3';
import { filterOperators, queryViewResult, viewFilters } from './viewQuery.js';
export { queryViewResult } from './viewQuery.js';
export const fieldSchema = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]*$/), label: z.string().min(1), type: z.enum(['text', 'number', 'boolean', 'date', 'select', 'multi', 'reference']), required: z.boolean().default(false), options: z.array(z.string()).optional() });
export const objectSchema = z.object({ id: z.string().min(1), kind: z.literal('object'), path: z.string().min(1), title: z.string().min(1), collection: z.string().nullable().default(null), fields: z.record(z.string(), z.unknown()).default({}), body: z.string().default('') });
export const collectionSchema = z.object({ id: z.string().min(1), kind: z.literal('collection'), path: z.string().min(1), title: z.string().min(1), fields: z.array(fieldSchema) });
export const viewFilterSchema = z.object({ key: z.string(), operator: z.enum(['contains','equals','startsWith','empty','notEmpty','gt','gte','lt','lte','between','in','today','last7days']), value: z.union([z.string(),z.number(),z.boolean(),z.array(z.union([z.string(),z.number(),z.boolean()]))]).optional() });
export const viewSchema = z.object({ id: z.string().min(1), kind: z.literal('view'), path: z.string().min(1), title: z.string().min(1), collection: z.string(), layout: z.enum(['table', 'list', 'cards']), columns: z.array(z.string()), filter: z.object({ key: z.string(), value: z.string() }).nullable().default(null), filters: z.array(viewFilterSchema).optional(), filterLogic: z.literal('and').optional(), search: z.string().optional(), pagination: z.object({ pageSize: z.union([z.literal(10),z.literal(25),z.literal(50),z.literal(100),z.null()]) }).optional(), sort: z.object({ key: z.string(), descending: z.boolean() }).nullable().default(null) });
export const folderSchema = z.object({ id: z.string().min(1), kind: z.literal('folder'), path: z.string().min(1), title: z.string().min(1) });
export const entitySchema = z.discriminatedUnion('kind', [objectSchema, collectionSchema, viewSchema, folderSchema]).refine(entity => /^[a-zA-Z0-9_-]+$/.test(entity.id) && !(entity.id in Object.prototype), '对象标识不合法');
export const operationSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('put'), entity: entitySchema, expected: entitySchema.nullable() }),
    z.object({ type: z.literal('delete'), id: z.string(), expected: entitySchema }),
    z.object({ type: z.literal('field'), id: z.string(), key: z.string().regex(/^[a-z][a-z0-9_]*$/).refine(key => !['constructor', 'prototype', '__proto__'].includes(key)), expected: z.unknown(), value: z.unknown() }),
    z.object({ type: z.literal('patch'), id: z.string(), before: z.string().min(1), after: z.string() }),
    z.object({ type: z.literal('directory'), from: z.string().min(1), to: z.string().nullable(), head: z.string() })
]);
export type Entity = z.infer<typeof entitySchema>;
export type DesignObject = z.infer<typeof objectSchema>;
export type Collection = z.infer<typeof collectionSchema>;
export type CollectionView = z.infer<typeof viewSchema>;
export type Field = z.infer<typeof fieldSchema>;
export type Tree = Record<string, Entity>;
export type Actor = {
    userId: string;
    username: string;
    projectId: string;
    kind: 'human' | 'agent';
    sessionId: string;
    scopes: string[];
    canSync: boolean;
    administrator?: boolean;
};
export const equal = (left: unknown, right: unknown): boolean => stable(left) === stable(right);
export function stable(value: unknown): string {
    if (value === undefined)
        return 'null';
    if (Array.isArray(value))
        return '[' + value.map(stable).join(',') + ']';
    if (value !== null && typeof value === 'object')
        return '{' + Object.entries(value).sort(([left], [right]) => left.localeCompare(right, 'en')).map(([key, item]) => JSON.stringify(key) + ':' + stable(item)).join(',') + '}';
    return JSON.stringify(value);
}
export function safePath(path: string) {
    if (path.startsWith('/') || path.includes('\\') || /[:\x00-\x1f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')))
        throw new Error('文件路径不合法');
    return path;
}
export function serialize(entity: Entity): string {
    if (entity.kind !== 'object')
        return JSON.stringify(entity, null, 2) + '\n';
    const { body, ...meta } = entity;
    return '---\n' + YAML.stringify(meta, { sortMapEntries: true, lineWidth: 0 }) + '---\n\n' + body.trimEnd() + '\n';
}
export function deserialize(text: string): Entity {
    if (!text.startsWith('---\n'))
        return entitySchema.parse(JSON.parse(text));
    const end = text.indexOf('\n---\n', 4);
    if (end < 0)
        throw new Error('缺少 YAML 结束标记');
    return entitySchema.parse({ ...YAML.parse(text.slice(4, end)), body: text.slice(end + 5).replace(/^\n/, '').trimEnd() });
}
export function references(entity: Entity): string[] { return entity.kind === 'object' ? markdownReferences(entity.body).documents : []; }
export function viewReferences(entity: Entity): string[] { return entity.kind === 'object' ? markdownReferences(entity.body).views : []; }
export function diagnostics(tree: Tree, publish = false, selected?: readonly string[]): string[] {
    const issues: string[] = [], paths = new Set<string>();
    for (const entity of selected ? selected.map(id => tree[id]) : Object.values(tree)) {
        try {
            safePath(entity.path);
            entitySchema.parse(entity);
        }
        catch {
            issues.push(entity.title + ': 数据或路径不合法');
        }
        if (paths.has(entity.path.toLowerCase()))
            issues.push('路径重复: ' + entity.path);
        paths.add(entity.path.toLowerCase());
        if (entity.kind === 'collection' && new Set(entity.fields.map(field => field.key)).size !== entity.fields.length)
            issues.push(entity.title + ': 字段标识重复');
        if (entity.kind === 'view') {
            const collection = tree[entity.collection];
            if (collection?.kind !== 'collection')
                issues.push(entity.title + ': 集合不存在');
            else if (entity.columns.some(key => key !== 'title' && !collection.fields.some(field => field.key === key)))
                issues.push(entity.title + ': 视图包含未知字段');
            if (collection?.kind === 'collection') {
                const fields = [{ key: 'title', type: 'text' as const }, ...collection.fields];
                if (entity.sort && !fields.some(field => field.key === entity.sort!.key)) issues.push(entity.title + ': 排序包含未知字段');
                const filters = viewFilters(entity);
                if (entity.filters && entity.filter) issues.push(entity.title + ': 不能同时填写旧 filter 与 filters，请使用 filters');
                if (new Set(filters.map(filter => filter.key)).size !== filters.length) issues.push(entity.title + ': 同一列只能有一组筛选');
                for (const filter of filters) {
                    const field = fields.find(field => field.key === filter.key);
                    if (!field || entity.filters && filter.operator !== 'contains' && !filterOperators[field.type].includes(filter.operator)) { issues.push(entity.title + ': 筛选字段或运算符不合法'); continue; }
                    const accepts = (value: unknown) => field.type === 'number' ? typeof value === 'number' && Number.isFinite(value) : field.type === 'boolean' ? typeof value === 'boolean' : typeof value === 'string' && (field.type !== 'date' || /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)));
                    if (['empty','notEmpty','today','last7days'].includes(filter.operator)) continue;
                    const valid = filter.operator === 'in' ? Array.isArray(filter.value) && filter.value.every(accepts) : filter.operator === 'between' ? Array.isArray(filter.value) && filter.value.length === 2 && filter.value.every(accepts) && filter.value[0] <= filter.value[1] : filter.operator === 'contains' || filter.operator === 'startsWith' ? typeof filter.value === 'string' : accepts(filter.value);
                    if (!valid) issues.push(entity.title + ': 筛选值不合法');
                }
            }
        }
        if (entity.kind !== 'object')
            continue;
        const collection = entity.collection ? tree[entity.collection] : null;
        if (entity.collection && collection?.kind !== 'collection')
            issues.push(entity.title + ': 集合不存在');
        if (collection?.kind === 'collection') {
            for (const key of Object.keys(entity.fields))
                if (!collection.fields.some(field => field.key === key))
                    issues.push(entity.title + ': 未定义字段 ' + key);
            for (const field of collection.fields) {
                const value = entity.fields[field.key];
                if (value === undefined || value === null || value === '') {
                    if (publish && field.required)
                        issues.push(entity.title + ': ' + field.label + ' 必填');
                    continue;
                }
                const valid = field.type === 'number' ? typeof value === 'number' && Number.isFinite(value) : field.type === 'boolean' ? typeof value === 'boolean' : field.type === 'multi' ? Array.isArray(value) && value.every(item => typeof item === 'string' && (!field.options || field.options.includes(item))) : typeof value === 'string' && (field.type !== 'select' || !field.options || field.options.includes(value)) && (field.type !== 'date' || /^\d{4}-\d{2}-\d{2}$/.test(value));
                if (!valid)
                    issues.push(entity.title + ': ' + field.label + ' 类型或选项不合法');
                if (publish && field.type === 'reference' && !tree[String(value)])
                    issues.push(entity.title + ': 引用不存在');
            }
        }
        if (publish) {
            for (const target of references(entity))
                if (!Object.hasOwn(tree, target))
                    issues.push(entity.title + ': 链接不存在 ' + target);
            for (const target of viewReferences(entity))
                if (tree[target]?.kind !== 'view')
                    issues.push(entity.title + ': 嵌入视图不存在');
        }
    }
    const conflicting = new Set<string>();
    for (const path of paths) {
        let boundary = path.indexOf('/');
        while (boundary >= 0) {
            const parent = path.slice(0, boundary);
            if (paths.has(parent)) conflicting.add(parent);
            boundary = path.indexOf('/', boundary + 1);
        }
    }
    for (const path of conflicting) issues.push('文件与目录路径冲突: ' + path);
    return issues;
}
export type Difference = {
    id: string;
    title: string;
    kind: string;
    property: string;
    before: unknown;
    after: unknown;
};
export function diffTrees(before: Tree, after: Tree): Difference[] {
    const result: Difference[] = [];
    for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const previous = before[id], next = after[id];
        if (equal(previous, next))
            continue;
        if (!previous || !next) {
            result.push({ id, title: (next || previous).title, kind: next ? '新增' : '删除', property: '对象', before: previous ?? null, after: next ?? null });
            continue;
        }
        for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
            const oldValue = (previous as any)[key], newValue = (next as any)[key];
            if (equal(oldValue, newValue))
                continue;
            if (key === 'fields' && previous.kind === 'object' && next.kind === 'object')
                for (const field of new Set([...Object.keys(previous.fields), ...Object.keys(next.fields)])) {
                    if (!equal(previous.fields[field], next.fields[field]))
                        result.push({ id, title: next.title, kind: '字段', property: field, before: previous.fields[field] ?? null, after: next.fields[field] ?? null });
                }
            else
                result.push({ id, title: next.title, kind: key === 'body' ? '正文' : key === 'path' ? '移动' : '修改', property: key, before: oldValue ?? null, after: newValue ?? null });
        }
    }
    return result;
}
export function mergeTrees(base: Tree, ours: Tree, theirs: Tree): {
    tree: Tree;
    conflicts: string[];
} {
    const conflicts: string[] = [];
    function merge(previous: any, left: any, right: any, path: string): any {
        if (equal(left, right) || equal(previous, right))
            return left;
        if (equal(previous, left))
            return right;
        if (previous && left && right && typeof previous === 'object' && typeof left === 'object' && typeof right === 'object' && !Array.isArray(previous) && !Array.isArray(left) && !Array.isArray(right)) {
            const result: Record<string, unknown> = {};
            for (const key of new Set([...Object.keys(previous), ...Object.keys(left), ...Object.keys(right)])) {
                const value = merge(previous[key], left[key], right[key], path + '/' + key);
                if (value !== undefined)
                    result[key] = value;
            }
            return result;
        }
        if (path.endsWith('/body') && typeof previous === 'string' && typeof left === 'string' && typeof right === 'string') {
            const merged = mergeDiff3(left.split('\n'), previous.split('\n'), right.split('\n'));
            if (!merged.conflict)
                return merged.result.join('\n');
        }
        conflicts.push(path);
        return left;
    }
    return { tree: merge(base, ours, theirs, ''), conflicts };
}
export function queryView(tree: Tree, view: CollectionView): DesignObject[] { return queryViewResult(tree, { ...view, pagination: { pageSize: null } }).rows; }
