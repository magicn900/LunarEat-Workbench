import { references, viewReferences, type Entity, type Tree } from './model.js';

export function deletionTargets(tree: Tree, entity: Entity): Entity[] {
    return Object.values(tree).filter(candidate => candidate.id === entity.id ||
        (entity.kind === 'collection' && (candidate.kind === 'object' || candidate.kind === 'view') && candidate.collection === entity.id));
}

export function deletionBlockers(tree: Tree, ids: Set<string>): Entity[] {
    return Object.values(tree).filter(entity => {
        if (ids.has(entity.id)) return false;
        if ((entity.kind === 'view' || entity.kind === 'object') && entity.collection && ids.has(entity.collection)) return true;
        if (entity.kind !== 'object') return false;
        if (references(entity).some(id => ids.has(id))) return true;
        if (viewReferences(entity).some(id => ids.has(id))) return true;
        const collection = entity.collection ? tree[entity.collection] : null;
        return collection?.kind === 'collection' && collection.fields.some(field => field.type === 'reference' && ids.has(String(entity.fields[field.key])));
    });
}
