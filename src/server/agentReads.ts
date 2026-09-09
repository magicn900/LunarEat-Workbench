import { diagnostics, references, viewReferences, type Actor, type Entity, type Tree, type CollectionView } from '../shared/model.js';
import { queryViewResult } from '../shared/viewQuery.js';
import { deletionBlockers } from '../shared/deletion.js';
import { agentViewSchema } from '../shared/agentContract.js';
import { AgentContext, agentFault } from './agentContext.js';

export class AgentReads {
    constructor(readonly context: AgentContext) {}
    get service() { return this.context.service; }
    related(tree: Tree, id: string, direction: string) {
        if (!tree[id]) agentFault('NOT_FOUND', 'Object does not exist in this source.', 'find_target', 404);
        if (direction === 'incoming') return deletionBlockers(tree, new Set([id]));
        const entity = tree[id];
        const ids = new Set<string>(references(entity));
        if ('collection' in entity && entity.collection) ids.add(entity.collection);
        if (entity.kind === 'object') {
            for (const target of viewReferences(entity)) ids.add(target);
            const collection = entity.collection ? tree[entity.collection] : null;
            if (collection?.kind === 'collection') for (const field of collection.fields) if (field.type === 'reference' && entity.fields[field.key]) ids.add(String(entity.fields[field.key]));
        }
        return [...ids].map(id => tree[id]).filter(Boolean);
    }
    fields(tree: Tree, entity: Entity, fields: string[]) {
        if (entity.kind === 'object' && entity.collection) {
            const collection = tree[entity.collection];
            if (collection?.kind === 'collection') for (const key of fields) if (!['id','title','path','kind','collection'].includes(key) && !collection.fields.some(field => field.key === key)) agentFault('UNKNOWN_FIELD', 'Unknown collection field: ' + key, 'read_collection_schema', 400);
        }
        return this.context.project(entity, fields);
    }
    find(actor: Actor, input: any) {
        if (input.cursor) return this.context.page(actor, input, [], {}, 'find');
        const source = this.context.source(actor, input), tree = this.context.tree(source);
        let entities = input.relation ? this.related(tree, input.relation.id, input.relation.direction) : Object.values(tree);
        entities = entities.filter((entity: Entity) => {
            if (input.kind && entity.kind !== input.kind) return false;
            if (input.collection && (!('collection' in entity) || entity.collection !== input.collection)) return false;
            if (input.query === undefined) return true;
            const value = input.mode === 'title' ? entity.title : input.mode === 'path' ? entity.path : entity.title + '\n' + entity.path + (entity.kind === 'object' ? '\n' + entity.body + '\n' + JSON.stringify(entity.fields) : '');
            return input.match === 'exact' ? value === input.query : value.toLocaleLowerCase().includes(input.query.toLocaleLowerCase());
        }).sort((left: Entity, right: Entity) => left.id.localeCompare(right.id, 'en'));
        const items = entities.map((entity: Entity) => ({ ...this.fields(tree, entity, input.fields), matchedBy: input.relation ? 'relation' : input.mode + ':' + input.match }));
        return this.context.page(actor, input, items, { snapshot: source.snapshot, source: source.revision ? { revision: source.revision } : { draftHead: source.tree } }, 'find');
    }
    read(actor: Actor, input: any) {
        if (input.cursor) return this.context.page(actor, input, [], {}, 'read');
        if (input.receipt) {
            const receipt = this.context.load(actor, input.receipt, 'receipt');
            return this.context.page(actor, input, receipt.items, { receipt: input.receipt, snapshot: receipt.snapshot }, 'read');
        }
        if (!input.ids?.length) agentFault('INPUT_REQUIRED', 'Supply ids, receipt or cursor.', 'read_help', 400);
        const source = this.context.source(actor, input), tree = this.context.tree(source);
        const metadata = { snapshot: source.snapshot, source: source.revision ? { revision: source.revision } : { draftHead: source.tree } };
        if (input.field) {
            if (input.ids.length !== 1) agentFault('ONE_TARGET_REQUIRED', 'Field-range reads require exactly one id.', 'choose_one_id', 400);
            const entity = tree[input.ids[0]];
            if (!entity) agentFault('NOT_FOUND', 'Object does not exist.', 'find_target', 404);
            if (entity.kind === 'object' && !['title','path','body','$entity','$fields'].includes(input.field)) this.fields(tree, entity, [input.field]);
            const value = input.field === '$entity' ? entity : input.field === '$fields' && entity.kind === 'object' ? entity.fields : ['title','path'].includes(input.field) ? (entity as any)[input.field] : entity.kind === 'object' ? input.field === 'body' ? entity.body : entity.fields[input.field] : (entity as any)[input.field];
            const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
            if (input.offset > text.length) agentFault('RANGE_INVALID', 'Offset exceeds field length.', 'restart_field_read', 400);
            const end = Math.min(text.length, input.offset + input.length);
            const complete = end >= text.length;
            return { ...metadata, id: entity.id, field: input.field, present: value !== undefined, encoding: typeof value === 'string' ? 'text' : 'json', text: text.slice(input.offset, end), offset: input.offset, end, totalLength: text.length, complete, next: complete ? null : { ids: input.ids, field: input.field, length: input.length, snapshot: source.snapshot, offset: end } };
        }
        const items = input.ids.map((id: string) => {
            const entity = tree[id];
            if (!entity) agentFault('NOT_FOUND', 'Object not found: ' + id, 'find_target', 404);
            const available = entity.kind === 'object' ? Object.keys(entity.fields) : [];
            const requested = input.fields.length ? input.fields : input.facets.includes('fields') ? available.slice(0, 20) : [];
            const result: Record<string, unknown> = this.fields(tree, entity, requested);
            if (input.facets.includes('fields') || input.fields.length) { result.fieldCount = available.length; result.fieldsComplete = requested.length === available.length && !result.omitted; result.allFields = { ids: [id], field: '$fields', snapshot: source.snapshot }; }
            result.version = this.service.store.hash(JSON.stringify(entity));
            if (entity.kind === 'view') result.definition = entity;
            if (input.facets.includes('schema')) {
                const collection = entity.kind === 'collection' ? entity : entity.kind === 'object' && entity.collection ? tree[entity.collection] : null;
                if (collection?.kind === 'collection') result.schema = { collection: collection.id, fields: input.fields.length ? collection.fields.filter(field => input.fields.includes(field.key)) : collection.fields, complete: !input.fields.length, fieldCount: collection.fields.length };
            }
            if (input.facets.includes('outline') && entity.kind === 'object') {
                const matches = [...entity.body.matchAll(/^#{1,6}\s+(.+)$/gm)];
                const sections = matches.length ? matches.map((match, index) => ({ start: match.index!, end: matches[index + 1]?.index ?? entity.body.length, title: match[1] })) : [{ start: 0, end: entity.body.length, title: entity.title }];
                result.outline = sections.slice(0, 30).map(section => this.context.section(actor, source, id, entity.body, section.start, section.end, section.title));
                result.outlineComplete = sections.length <= 30;
                result.bodyLength = entity.body.length;
            }
            if (input.facets.includes('references')) {
                result.references = Object.fromEntries(['incoming','outgoing'].map(direction => {
                    const related = this.related(tree, id, direction);
                    return [direction, { count: related.length, items: related.slice(0, 5).map(entity => this.context.metadata(entity)), complete: related.length <= 5, find: { snapshot: source.snapshot, relation: { id, direction } } }];
                }));
            }
            return result;
        });
        return this.context.page(actor, input, items, metadata, 'read');
    }
    definition(tree: Tree, input: any): CollectionView {
        if (!!input.view === !!input.definition) agentFault('QUERY_REQUIRED', 'Choose a saved view OR a collection definition.', 'read_query_schema', 400);
        let view: CollectionView;
        if (input.view) {
            const entity = tree[input.view];
            if (entity?.kind !== 'view') agentFault('NOT_A_VIEW', 'Target is not a saved view.', 'find_view', 404);
            view = entity;
        } else {
            const definition = input.definition;
            const collection = tree[definition.collection];
            if (collection?.kind !== 'collection') agentFault('NOT_A_COLLECTION', 'Collection does not exist.', 'find_collection', 404);
            view = agentViewSchema.parse({ id: 'agent-query', kind: 'view', layout: 'table', title: 'Agent query', path: 'agent-query.json', ...definition, columns: definition.columns || ['title', ...collection.fields.map(field => field.key)] });
        }
        const virtualId = 'agent-query-validation';
        const baseline = new Set(diagnostics(tree));
        const problems = diagnostics({ ...tree, [virtualId]: { ...view, id: virtualId, path: 'agent-query-' + this.service.store.hash(view.id) + '.json' } }).filter(problem => !baseline.has(problem));
        if (problems.length) agentFault('QUERY_INVALID', 'Query does not match the collection schema.', 'read_collection_schema', 422, problems.slice(0, 10));
        return view;
    }
    query(actor: Actor, input: any) {
        if (input.cursor) return this.context.page(actor, input, [], {}, 'query');
        const source = this.context.source(actor, input), tree = this.context.tree(source), view = this.definition(tree, input);
        const now = new Date();
        const result = queryViewResult(tree, { ...view, pagination: undefined }, 1, now);
        const selection = input.selection ? this.context.save(actor, 'selection', { source, view, now: now.toISOString() }) : undefined;
        const fields = input.fields.length ? input.fields : view.columns.filter(column => column !== 'title');
        const items = result.rows.map(entity => this.fields(tree, entity, fields));
        return this.context.page(actor, input, items, { snapshot: source.snapshot, source: source.revision ? { revision: source.revision } : { draftHead: source.tree }, ...selection ? { selection } : {}, query: { collection: view.collection, filters: view.filters ?? view.filter, sort: view.sort, pagination: view.pagination || { pageSize: null } }, matchedCount: result.filteredCount, collectionCount: result.totalCount }, 'query');
    }
    viewCheck(tree: Tree, entity: CollectionView) {
        const result = queryViewResult(tree, entity);
        const definition = { filters: entity.filters ?? entity.filter, sort: entity.sort, columns: entity.columns };
        return { id: entity.id, collection: entity.collection, ...Buffer.byteLength(JSON.stringify(definition)) <= 2000 ? definition : { definitionOmitted: true }, pageSize: result.pageSize, matchedCount: result.filteredCount, pageCount: result.pageCount, sample: result.rows.slice(0, 3).map(row => this.context.metadata(row)), definition: { command: 'read', ids: [entity.id] } };
    }
}
