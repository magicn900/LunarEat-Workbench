import { diagnostics, entitySchema, equal, safePath, type Tree } from '../shared/model.js';
import { deletionBlockers } from '../shared/deletion.js';
import type { Operation } from './service.js';
import type { Codec } from './codec.js';
import { Fault } from './fault.js';

export function applyMutationOperation(tree: Tree, head: string, operation: Operation, codec: Codec, bodies: Set<string>) {

    if (operation.type === 'directory') {
        safePath(operation.from);
        if (operation.to)
            safePath(operation.to);
        if (head !== operation.head)
            throw new Fault(409, '目录操作前工作区已变化');
        if (operation.to && (operation.to === operation.from || operation.to.startsWith(operation.from + '/')))
            throw new Fault(400, '不能移动到自身目录');
        for (const entity of Object.values(tree))
            if (entity.path.startsWith(operation.from + '/')) {
                if (operation.to)
                    entity.path = operation.to + entity.path.slice(operation.from.length);
                else {
                    delete tree[entity.id];
                    bodies.add(entity.id);
                }
            }
    }
    else if (operation.type === 'put') {
        const entity = entitySchema.parse(operation.entity);
        if (!equal(tree[entity.id] ?? null, operation.expected))
            throw new Fault(409, '对象已被修改，请重新读取', entity.id);
        if (entity.kind === 'object') {
            entity.body = codec.serialize(codec.parse(entity.body));
            bodies.add(entity.id);
        }
        tree[entity.id] = entity;
    }
    else if (operation.type === 'delete') {
        if (!equal(tree[operation.id], operation.expected))
            throw new Fault(409, '对象已被修改');
        delete tree[operation.id];
        bodies.add(operation.id);
    }
    else {
        const entity = tree[operation.id];
        if (entity?.kind !== 'object')
            throw new Fault(404, '对象不存在');
        if (operation.type === 'field') {
            if (!equal(entity.fields[operation.key] ?? null, operation.expected))
                throw new Fault(409, '字段已被修改', entity.fields[operation.key]);
            if (operation.value === null)
                delete entity.fields[operation.key];
            else
                entity.fields[operation.key] = operation.value;
        }
        else if (operation.type === 'patch') {
            if (!operation.before || entity.body.split(operation.before).length !== 2)
                throw new Fault(409, '补丁原文不存在或不唯一，请重新读取');
            entity.body = codec.serialize(codec.parse(entity.body.replace(operation.before, () => operation.after)));
            bodies.add(entity.id);
        }
        else
            throw new Fault(400, '未知操作');
    }
}
export function validateMutation(before: Tree, tree: Tree) {
    const deleted = new Set(Object.keys(before).filter(id => !tree[id]));
    const blockers = deletionBlockers(tree, deleted);
    if (blockers.length) throw new Fault(409, '删除被引用的内容前，请先移除引用：' + blockers.map(entity => entity.title).join('、'));
    const errors = diagnostics(tree);
    if (errors.length) throw new Fault(422, '数据校验失败', errors);
}
export function prepareMutation(before: Tree, head: string, operations: Operation[], codec: Codec) {
    const tree = structuredClone(before), bodies = new Set<string>();
    for (const operation of operations) applyMutationOperation(tree, head, operation, codec, bodies);
    validateMutation(before, tree);
    return { tree, bodies };
}
