import { z } from 'zod';
import { objectSchema, collectionSchema, viewSchema, folderSchema, fieldSchema, viewFilterSchema, entitySchema } from './model.js';

const id = z.string().min(1).max(200);
const requestId = z.string().min(1).max(140);
const reference = z.string().uuid();
const page = { cursor: reference.optional(), limit: z.number().int().min(1).max(50).default(20), maxBytes: z.number().int().min(2048).max(32768).default(12000) };
const source = { snapshot: reference.optional(), revision: id.optional() };
const strictSort = viewSchema.shape.sort.removeDefault().unwrap().strict();
const strictPagination = viewSchema.shape.pagination.unwrap().strict();
export const agentViewSchema = viewSchema.strict().extend({ filter: z.null().default(null), filters: z.array(viewFilterSchema.strict()).default([]), sort: strictSort.nullable().default(null), pagination: strictPagination.optional() });
export const agentEntitySchema = z.discriminatedUnion('kind', [objectSchema.strict(), collectionSchema.strict().extend({ fields: z.array(fieldSchema.strict()) }), agentViewSchema, folderSchema.strict()]).refine(value => entitySchema.safeParse(value).success, 'Invalid entity ID or content');
const queryDefinition = z.strictObject({ collection: id, filters: z.array(viewFilterSchema.strict()).default([]), sort: strictSort.nullable().default(null), columns: z.array(id).min(1).max(30).optional(), search: z.string().max(200).optional() });
const fieldOperation = z.strictObject({ type: z.literal('field'), id, key: id, value: z.unknown(), expected: z.unknown().optional() });
const editOperation = z.discriminatedUnion('type', [
    fieldOperation,
    z.strictObject({ type: z.literal('patch'), id, before: z.string().min(1), after: z.string() }),
    z.strictObject({ type: z.literal('put'), entity: agentEntitySchema, expected: entitySchema.nullable().optional(), alias: id.optional() }),
    z.strictObject({ type: z.literal('delete'), id }),
    z.strictObject({ type: z.literal('section'), section: reference, text: z.string() }),
    z.strictObject({ type: z.literal('embed'), id, target: id, format: z.enum(['view','document','link']).default('view'), after: z.string().min(1), label: z.string().max(200).optional() }),
    z.strictObject({ type: z.literal('bulk-field'), selection: reference, key: id, value: z.unknown() }),
    z.strictObject({ type: z.literal('metadata'), id, title: z.string().min(1).max(500).optional(), path: z.string().min(1).max(1000).optional() }),
    z.strictObject({ type: z.literal('directory'), from: z.string().min(1), to: z.string().min(1).nullable() })
]);
export const controlFields = { taskId: id.optional(), writeSessionId: reference.optional() };
export const editSchema = z.strictObject({ ...controlFields, requestId: requestId.optional(), mode: z.enum(['preview','apply']).default('apply'), snapshot: reference.optional(), plan: reference.optional(), operations: z.array(editOperation).min(1).max(500).optional() });
const versionBase = { ...page };
export const agentSchemas = {
    connect: z.strictObject({}),
    schema: z.strictObject({ name: z.string().default('index') }),
    find: z.strictObject({ ...source, ...page, query: z.string().max(500).optional(), mode: z.enum(['title','path','text']).default('title'), match: z.enum(['exact','contains']).default('exact'), kind: z.enum(['object','collection','view','folder']).optional(), collection: id.optional(), relation: z.strictObject({ id, direction: z.enum(['incoming','outgoing']) }).optional(), fields: z.array(id).max(20).default([]) }),
    read: z.strictObject({ ...source, ...page, ids: z.array(id).min(1).max(20).optional(), facets: z.array(z.enum(['fields','schema','outline','references'])).default([]), fields: z.array(id).max(30).default([]), field: id.optional(), offset: z.number().int().nonnegative().default(0), length: z.number().int().min(1).max(4000).default(2000), receipt: reference.optional() }),
    query: z.strictObject({ ...source, ...page, view: id.optional(), definition: queryDefinition.optional(), fields: z.array(id).max(30).default([]), selection: z.boolean().default(false) }),
    edit: editSchema,
    history: z.strictObject({ ...page, ...controlFields, action: z.enum(['list','inspect','undo','redo']).default('list'), id: id.optional(), objectId: id.optional(), actor: z.enum(['human','agent']).optional(), requestId: requestId.optional() }),
    versions: z.discriminatedUnion('action', [
        z.strictObject({ action: z.literal('list'), ...versionBase }),
        z.strictObject({ action: z.literal('inspect'), id: id.optional(), objectId: id.optional(), ...versionBase }),
        z.strictObject({ action: z.literal('confirmations'), id: id.optional(), ...versionBase }),
        z.strictObject({ action: z.literal('review'), ...versionBase }),
        z.strictObject({ action: z.literal('withdraw'), ...controlFields, requestId, id, revision: id }),
        z.strictObject({ action: z.literal('publish'), ...controlFields, requestId, review: reference, title: z.string().min(1).max(200), description: z.string().max(20000).default('') }),
        z.strictObject({ action: z.literal('refresh'), ...controlFields, requestId, review: reference, resolutions: z.record(z.string(), z.enum(['ours','theirs'])).optional() }),
        z.strictObject({ action: z.literal('discard-preview'), review: reference, targets: z.array(z.strictObject({ id, key: z.string().optional() })).min(1).max(500) }),
        z.strictObject({ action: z.literal('discard'), ...controlFields, requestId, plan: reference }),
        z.strictObject({ action: z.literal('sync'), requestId, ids: z.array(id).min(1).max(100), repository: z.string().min(1), commit: z.string().min(1), note: z.string().min(1), active: z.boolean() })
    ]),
    control: z.strictObject({ ...controlFields, action: z.enum(['status','release','request']), title: z.string().max(200).optional() }),
    inspiration: z.discriminatedUnion('action', [
        z.strictObject({ action: z.literal('find'), query: z.string().max(500).default(''), ...page }),
        z.strictObject({ action: z.literal('read'), id, version: z.number().int().optional(), offset: z.number().int().nonnegative().default(0), length: z.number().int().min(1).max(4000).default(2000) }),
        z.strictObject({ action: z.literal('write'), requestId, id: id.optional(), version: z.number().int().optional(), title: z.string().max(200), body: z.string().max(200000), tags: z.array(z.string()).max(30), remove: z.boolean().optional() }),
        z.strictObject({ action: z.literal('promote'), ...controlFields, requestId, id, version: z.number().int() })
    ])
};
export type AgentCommand = keyof typeof agentSchemas;
export const agentExamples: Record<AgentCommand, unknown> = {
    connect: {}, schema: { name: 'view' }, find: { query: '霜刃', collection: 'skills', fields: ['cost'] },
    read: { ids: ['skills'], facets: ['schema'] }, query: { definition: { collection: 'skills', filters: [{ key: 'cost', operator: 'equals', value: 1 }] }, fields: ['cost'], selection: true },
    edit: { snapshot: '<snapshot from find/read>', operations: [{ type: 'field', id: 'frost', key: 'cost', value: 3 }] },
    history: { objectId: 'frost', actor: 'agent' }, versions: { action: 'list' }, control: { action: 'release' }, inspiration: { action: 'find', query: '天气' }
};
export const agentDescriptions: Record<AgentCommand, string> = {
    connect: 'Verify identity, source and capabilities without reading design bodies.', schema: 'Discover exact input contracts and entity definitions; no guessing.',
    find: 'Locate by exact title/path or explicit full text; metadata and requested fields only.', read: 'Read selected entities, schemas, sections or a bounded field range at a fixed source.',
    query: 'Typed collection or saved-view query with projection, stable pagination and optional frozen selection.', edit: 'Atomic conditional changes; preview destructive impact; verify persisted fields and actual view results.',
    history: 'Filtered history summaries, one diff, safe undo/redo.', versions: 'Bounded publication/review context, fixed revisions, explicit publish/withdraw/discard/refresh/sync.',
    control: 'Inspect control, release an owned task, or explicitly resume; never silently reacquire.', inspiration: 'Explicit, separately authorized shared inspiration; never merged with design search.'
};
export function describeAgentCommand(name: string): unknown {
    if (name === 'index') return { commands: Object.entries(agentDescriptions).map(([command, description]) => ({ command, description })), entities: ['object','collection','view','folder'], next: 'schema {name:command or entity}' };
    const entities = { object: objectSchema.strict(), collection: collectionSchema.strict().extend({ fields: z.array(fieldSchema.strict()) }), view: agentViewSchema, folder: folderSchema.strict() };
    const [parent, operation] = name.split('.');
    const variants = parent === 'edit' ? editOperation.options : parent === 'versions' ? agentSchemas.versions.options : parent === 'inspiration' ? agentSchemas.inspiration.options : [];
    const leaf = operation ? variants.find(schema => ('type' in schema.shape ? schema.shape.type : schema.shape.action).value === operation) : undefined;
    const schema = operation ? leaf : Object.hasOwn(agentSchemas, name) ? agentSchemas[name as AgentCommand] : Object.hasOwn(entities, name) ? entities[name as keyof typeof entities] : undefined;
    if (!schema) return null;
    const input = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
    if (name === 'edit' && input.properties?.operations) {
        (input.properties.operations as any).items = { description: 'Choose an operation from operationHelp; fetch only that schema.' };
        return { name, input, operationHelp: editOperation.options.map(schema => 'edit.' + schema.shape.type.value), example: agentExamples.edit, description: agentDescriptions.edit, complete: false };
    }
    return { name, input, example: agentExamples[name as AgentCommand], description: agentDescriptions[name as AgentCommand] };
}
export function agentContractCatalog() {
    const names = ['index', ...Object.keys(agentSchemas), 'object', 'collection', 'view', 'folder', ...editOperation.options.map(schema => 'edit.' + schema.shape.type.value), ...agentSchemas.versions.options.map(schema => 'versions.' + schema.shape.action.value), ...agentSchemas.inspiration.options.map(schema => 'inspiration.' + schema.shape.action.value)];
    return Object.fromEntries(names.map(name => [name, describeAgentCommand(name)]));
}
export function parseAgentInput(command: AgentCommand, raw: unknown) {
    const data = raw as Record<string, unknown>;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
        const reject = (keys: string[]) => {
            const unused = keys.filter(key => Object.hasOwn(data, key));
            if (unused.length) throw new z.ZodError(unused.map(key => ({ code: 'custom', path: [key], message: 'Parameter is not used in this mode; omit it.' })));
        };
        if (data.cursor) reject(Object.keys(data).filter(key => !['cursor','action','limit','maxBytes'].includes(key)));
        if (command === 'read') {
            if (data.receipt) reject(['ids','snapshot','revision','facets','fields','field','offset','length']);
            if (data.field) reject(['facets','fields','limit','maxBytes']);
            else reject(['offset','length']);
        }
        if (command === 'edit') {
            if (data.plan) reject(['operations','snapshot']);
            if (data.mode === 'preview') reject(['requestId','taskId','writeSessionId','plan']);
        }
        if (command === 'history') {
            if (!data.action || data.action === 'list') reject(['id','taskId','writeSessionId','requestId']);
            else if (data.action === 'inspect') reject(['actor','taskId','writeSessionId','requestId']);
            else reject(['actor','cursor','limit','maxBytes']);
        }
        if (command === 'control' && data.action === 'status') reject(['taskId','writeSessionId','title']);
        if (command === 'control' && data.action === 'release') reject(['title']);
    }
    return agentSchemas[command].parse(raw);
}
