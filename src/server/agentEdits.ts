import { equal, stable, type Actor, type Tree, type Entity } from '../shared/model.js';
import { queryViewResult } from '../shared/viewQuery.js';
import { agentEntitySchema } from '../shared/agentContract.js';
import { requireScope } from './auth.js';
import { writableProject } from './projectState.js';
import { AgentContext, agentFault } from './agentContext.js';
import { AgentReads } from './agentReads.js';
import { applyMutationOperation, validateMutation } from './mutations.js';
import type { Operation } from './service.js';

export class AgentEdits {
    constructor(readonly context: AgentContext, readonly reads: AgentReads) {}
    get service() { return this.context.service; }
    requestKey(actor: Actor, input: { requestId: string }) { return 'agent:' + this.service.store.hash(stable([actor.sessionId, actor.projectId, input.requestId])); }
    private request(actor: Actor, command: string, input: any) {
        writableProject(this.service.store, actor.projectId);
        if (!input.requestId) agentFault('REQUEST_ID_REQUIRED', 'A requestId is required for mutations.', 'reuse_stable_request_id', 400);
        const { writeSessionId: _session, ...logical } = input;
        return { key: actor.sessionId + ':' + actor.projectId + ':' + input.requestId, digest: this.service.store.hash(stable({ command, input: logical })) };
    }
    replay(actor: Actor, command: string, input: any) {
        const { key, digest } = this.request(actor, command, input);
        const cached = this.service.store.db.prepare('SELECT * FROM agent_requests WHERE key=?').get(key) as { digest: string; result: string } | undefined;
        if (!cached) return null;
        if (cached.digest !== digest) agentFault('REQUEST_ID_REUSED', 'This requestId belongs to different input.', 'use_new_id_for_new_intent', 409);
        return { ...JSON.parse(cached.result), replayed: true };
    }
    execute(actor: Actor, command: string, input: any, operation: () => any, controlled = true, transactional = true) {
        const cached = this.replay(actor, command, input);
        if (cached) return cached;
        const { key, digest } = this.request(actor, command, input);
        const run = () => {
            const value = operation();
            const result = controlled ? { ...value, writeSessionId: this.service.control.current(this.service.workspace(actor).id)?.id } : value;
            this.service.store.db.prepare('INSERT INTO agent_requests VALUES (?,?,?)').run(key, digest, JSON.stringify(result));
            return result;
        };
        return controlled ? this.service.execute(actor, input, run, transactional) : this.service.store.db.transaction(run)();
    }
    build(actor: Actor, input: any) {
        if (!input.operations?.length) agentFault('OPERATIONS_REQUIRED', 'Supply operations or a reviewed plan.', 'read_edit_help', 400);
        const workspace = this.service.workspace(actor), before = this.service.store.tree(workspace.head), working = structuredClone(before);
        const basisSource = input.snapshot ? this.context.source(actor, { snapshot: input.snapshot }) : null;
        if (basisSource?.revision) agentFault('READ_ONLY_SOURCE', 'Formal revisions cannot be edited. Read the draft first.', 'read_draft', 400);
        const basis = basisSource ? this.context.tree(basisSource) : null;
        const operations: Operation[] = [], bodies = new Set<string>(), aliases = new Map<string, string>();
        let destructive = false;
        for (const operation of input.operations) if (operation.type === 'put' && operation.alias) {
            if (aliases.has(operation.alias)) agentFault('DUPLICATE_ALIAS', 'Batch aliases must be unique.', 'rename_alias', 400);
            aliases.set(operation.alias, operation.entity.id);
        }
        const target = (value: string) => value.startsWith('$') ? aliases.get(value.slice(1)) || agentFault('UNKNOWN_ALIAS', 'Unknown batch alias: ' + value, 'declare_alias', 400) : value;
        const append = (operation: Operation) => {
            if (operations.length >= 500) agentFault('BATCH_TOO_LARGE', 'Atomic edits support at most 500 operations; narrow the selection.', 'narrow_selection', 413);
            applyMutationOperation(working, workspace.head, operation, this.service.codec, bodies);
            operations.push(operation);
        };
        for (const operation of input.operations) {
            if (operation.type === 'metadata') {
                const id = target(operation.id), original = basis?.[id], current = working[id];
                if (!original || !current) agentFault('BASIS_REQUIRED', 'Metadata edits require a snapshot containing the target.', 'find_target', 400);
                const keys = ['title','path'].filter(key => Object.hasOwn(operation, key)) as ('title'|'path')[];
                if (!keys.length) agentFault('VALUE_REQUIRED', 'Supply title or path.', 'read_metadata_schema', 400);
                for (const key of keys) if (!equal(original[key], current[key])) agentFault('METADATA_CHANGED', 'Metadata changed since the read.', 'find_target');
                append({ type: 'put', expected: current, entity: { ...current, ...Object.fromEntries(keys.map(key => [key, operation[key]])) } });
            } else if (operation.type === 'directory') {
                if (!basisSource || basisSource.tree !== workspace.head) agentFault('BASIS_REQUIRED', 'Directory operations require an unchanged draft snapshot.', 'find_directory');
                destructive ||= operation.to === null;
                append({ type: 'directory', from: operation.from, to: operation.to, head: workspace.head });
            } else if (operation.type === 'field') {
                if (!('value' in operation)) agentFault('VALUE_REQUIRED', 'Field edits require value; null removes the optional value.', 'supply_value', 400);
                const id = target(operation.id);
                if (!('expected' in operation) && !basis) agentFault('BASIS_REQUIRED', 'Supply snapshot from a read or an explicit expected value.', 'read_target', 400);
                const entity = basis?.[id];
                if (basis && entity?.kind === 'object' && entity.collection && !equal(basis[entity.collection], before[entity.collection])) agentFault('SCHEMA_CHANGED', 'Collection schema changed since the read.', 'read_collection_schema');
                append({ type: 'field', id, key: operation.key, expected: 'expected' in operation ? operation.expected : entity?.kind === 'object' ? entity.fields[operation.key] ?? null : null, value: operation.value });
            } else if (operation.type === 'patch') append({ ...operation, id: target(operation.id) });
            else if (operation.type === 'put') {
                const entity = agentEntitySchema.parse(operation.entity);
                if (working[entity.id] && !('expected' in operation) && !basis) agentFault('BASIS_REQUIRED', 'Replacing existing content requires a read snapshot or expected entity.', 'read_target', 400);
                const previous = before[entity.id];
                if (previous?.kind === 'collection' && entity.kind === 'collection' && previous.fields.some(field => !entity.fields.some(next => next.key === field.key))) destructive = true;
                append({ type: 'put', entity, expected: 'expected' in operation ? operation.expected : basis?.[entity.id] || null });
            } else if (operation.type === 'delete') {
                const id = target(operation.id);
                if (!basis?.[id]) agentFault('BASIS_REQUIRED', 'Deletion requires a draft snapshot containing the target.', 'read_target', 400);
                destructive = true;
                append({ type: 'delete', id, expected: basis[id] });
            } else if (operation.type === 'section') {
                const section = this.context.load(actor, operation.section, 'section');
                if (section.source.revision) agentFault('READ_ONLY_SOURCE', 'Section belongs to a formal revision.', 'read_draft', 400);
                const original = this.context.tree(section.source)[section.id], current = working[section.id];
                if (original?.kind !== 'object' || current?.kind !== 'object' || original.body !== current.body) agentFault('SECTION_CHANGED', 'Document changed since the section was read.', 'read_outline');
                append({ type: 'put', expected: current, entity: { ...current, body: current.body.slice(0, section.start) + operation.text + current.body.slice(section.end) } });
            } else if (operation.type === 'embed') {
                const id = target(operation.id), linkedId = target(operation.target), linked = working[linkedId];
                if (!linked || (operation.format === 'view' ? linked.kind !== 'view' : linked.kind !== 'object')) agentFault('EMBED_TARGET_INVALID', 'Embed target has the wrong type or does not exist.', 'find_target', 422);
                const label = (operation.label || linked.title).replace(/[\[\]\\]/g, (character: string) => '\\' + character);
                const markdown = operation.format === 'view' ? ':::view[' + linkedId + ']' : operation.format === 'document' ? ':::doc[' + linkedId + ']' : '[' + label + '](doc:' + linkedId + ')';
                append({ type: 'patch', id, before: operation.after, after: operation.after + '\n\n' + markdown });
            } else if (operation.type === 'bulk-field') {
                const selection = this.context.load(actor, operation.selection, 'selection');
                if (selection.source.revision) agentFault('READ_ONLY_SOURCE', 'Selection belongs to a formal revision.', 'query_draft', 400);
                const original = this.context.tree(selection.source), view = selection.view;
                if (!equal(original[view.collection], before[view.collection])) agentFault('SCHEMA_CHANGED', 'Collection schema changed.', 'repeat_query');
                const selected = queryViewResult(original, { ...view, pagination: undefined }, 1, new Date(selection.now)).rows;
                const current = queryViewResult(before, { ...view, pagination: undefined }, 1, new Date(selection.now)).rows;
                if (!selected.length) agentFault('EMPTY_SELECTION', 'No matching objects; nothing was written.', 'adjust_query', 422);
                if (!equal(selected.map(row => row.id), current.map(row => row.id))) agentFault('SELECTION_CHANGED', 'Query membership/order changed; no targets were silently added or skipped.', 'repeat_query');
                for (const entity of selected) append({ type: 'field', id: entity.id, key: operation.key, expected: entity.fields[operation.key] ?? null, value: operation.value });
            }
        }
        validateMutation(before, working);
        return { before, tree: working, head: workspace.head, operations, destructive, aliases: Object.fromEntries(aliases) };
    }
    receipt(actor: Actor, before: Tree, after: Tree, extra: Record<string, unknown> = {}) {
        const ids = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(id => !equal(before[id], after[id]));
        const items = ids.map(id => {
            const previous = before[id], entity = after[id];
            const fields = entity?.kind === 'object' ? Object.keys({ ...(previous?.kind === 'object' ? previous.fields : {}), ...entity.fields }).filter(key => previous?.kind !== 'object' || !equal(previous.fields[key], entity.fields[key])) : [];
            return { ...this.context.metadata(entity || previous), change: !previous ? 'created' : !entity ? 'deleted' : 'updated', ...entity?.kind === 'object' ? { ...this.context.project(entity, fields.slice(0, 5)), changedFieldCount: fields.length, fieldsComplete: fields.length <= 5, read: { ids: [id], facets: ['fields'] }, bodyChanged: previous?.kind !== 'object' || previous.body !== entity.body } : {} };
        });
        const views = ids.map(id => after[id]).filter((entity): entity is Extract<Entity, { kind: 'view' }> => entity?.kind === 'view');
        const fieldChecks = new Map<string, { key: string; value?: unknown; absent: boolean; count: number; valueOmitted?: boolean }>();
        let bodyChangedCount = 0;
        for (const id of ids) {
            const previous = before[id], entity = after[id];
            if (entity?.kind !== 'object') continue;
            if (previous?.kind !== 'object' || previous.body !== entity.body) bodyChangedCount++;
            for (const key of Object.keys({ ...(previous?.kind === 'object' ? previous.fields : {}), ...entity.fields })) {
                if (previous?.kind === 'object' && equal(previous.fields[key], entity.fields[key])) continue;
                const value = entity.fields[key], signature = stable([key, value]);
                const entry = fieldChecks.get(signature) || { key, ...Buffer.byteLength(signature) <= 500 ? { value } : { valueOmitted: true }, absent: value === undefined, count: 0 };
                entry.count++; fieldChecks.set(signature, entry);
            }
        }
        const snapshot = extra.snapshot || this.context.save(actor, 'snapshot', { tree: this.service.store.putTree(after), revision: null });
        for (const item of items) if ('read' in item) item.read = { ...item.read, snapshot } as typeof item.read;
        const receipt = this.context.save(actor, 'receipt', { items, snapshot });
        const page = this.context.page(actor, { limit: 3, maxBytes: 16000 }, items);
        return { ...extra, snapshot, changedCount: ids.length, changes: page.items, changesComplete: page.complete, receipt, checks: { persisted: true, bodyChangedCount, fields: [...fieldChecks.values()].slice(0, 5), fieldsComplete: fieldChecks.size <= 5, views: views.slice(0, 3).map(view => this.reads.viewCheck(after, view)), viewsComplete: views.length <= 3 } };
    }
    edit(actor: Actor, input: any) {
        requireScope(actor, 'workspace.read'); requireScope(actor, 'workspace.write');
        if (input.plan && input.operations) agentFault('INPUT_AMBIGUOUS', 'Use a reviewed plan or operations, not both.', 'choose_edit_mode', 400);
        if (input.mode === 'preview') {
            const plan = this.build(actor, input);
            const handle = this.context.save(actor, 'edit-plan', { head: plan.head, operations: plan.operations, aliases: plan.aliases });
            const result = this.receipt(actor, plan.before, plan.tree, { plan: handle, requiresConfirmation: plan.destructive, aliases: plan.aliases });
            result.checks.persisted = false;
            return result;
        }
        return this.execute(actor, 'edit', input, () => {
            const before = this.service.store.tree(this.service.workspace(actor).head);
            let operations: Operation[], aliases: Record<string, string>;
            if (input.plan) {
                const plan = this.context.load(actor, input.plan, 'edit-plan');
                if (plan.head !== this.service.workspace(actor).head) agentFault('PLAN_STALE', 'Draft changed since preview.', 'preview_again');
                operations = plan.operations; aliases = plan.aliases;
            } else {
                const plan = this.build(actor, input);
                if (plan.destructive) agentFault('PREVIEW_REQUIRED', 'Deletion or field removal requires a reviewed preview.', 'edit_preview', 409);
                operations = plan.operations; aliases = plan.aliases;
            }
            const result = this.service.mutate(actor, this.requestKey(actor, input), operations);
            const after = this.service.store.tree(this.service.workspace(actor).head);
            return this.receipt(actor, before, after, { ...result, aliases, snapshot: this.context.source(actor, {}).snapshot });
        });
    }
}
