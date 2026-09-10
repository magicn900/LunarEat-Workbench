import { randomUUID } from 'node:crypto';
import type { Actor, Entity, Tree } from '../shared/model.js';
import type { Service } from './service.js';
import { Fault, requireScope } from './auth.js';

export function agentFault(code: string, message: string, next: string, status = 409, details?: unknown): never {
    throw new Fault(status, message, { code, requiredAction: next, retryable: false, ...details ? { context: details } : {} });
}
export class AgentContext {
    constructor(readonly service: Service) {
        service.store.db.exec('CREATE TABLE IF NOT EXISTS agent_contexts(id TEXT PRIMARY KEY,owner TEXT NOT NULL,project TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,expires INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS agent_context_owner ON agent_contexts(owner,project); CREATE TABLE IF NOT EXISTS agent_requests(key TEXT PRIMARY KEY,digest TEXT NOT NULL,result TEXT NOT NULL);');
    }
    save(actor: Actor, kind: string, data: unknown) {
        const db = this.service.store.db;
        const payload = JSON.stringify(data);
        if (Buffer.byteLength(payload) > 8 * 1024 * 1024) agentFault('CONTEXT_TOO_LARGE', 'Selection is too broad.', 'narrow_query', 413);
        db.prepare('DELETE FROM agent_contexts WHERE expires<=?').run(Date.now());
        const count = (db.prepare('SELECT COUNT(*) count FROM agent_contexts WHERE owner=? AND project=?').get(actor.sessionId, actor.projectId) as { count: number }).count;
        if (count >= 512) agentFault('CONTEXT_LIMIT', 'Too many active context handles. Reuse snapshots/cursors or wait for expiry.', 'reuse_context', 429);
        const id = randomUUID();
        db.prepare('INSERT INTO agent_contexts VALUES (?,?,?,?,?,?)').run(id, actor.sessionId, actor.projectId, kind, payload, Date.now() + 15 * 60 * 1000);
        return id;
    }
    load(actor: Actor, id: string, kind: string): any {
        const row = this.service.store.db.prepare('SELECT payload FROM agent_contexts WHERE id=? AND owner=? AND project=? AND kind=? AND expires>?').get(id, actor.sessionId, actor.projectId, kind, Date.now()) as { payload: string } | undefined;
        if (!row) agentFault('CONTEXT_EXPIRED', 'Context expired, has the wrong purpose, or belongs to another connection.', 'repeat_original_read', 410);
        return JSON.parse(row.payload);
    }
    source(actor: Actor, input: { snapshot?: string; revision?: string }) {
        requireScope(actor, 'workspace.read');
        if (input.snapshot && input.revision) agentFault('SOURCE_AMBIGUOUS', 'Choose snapshot or revision, not both.', 'choose_source', 400);
        if (input.snapshot) return { ...this.load(actor, input.snapshot, 'snapshot'), snapshot: input.snapshot } as { tree: string; revision: string | null; snapshot: string };
        const workspace = this.service.workspace(actor);
        let tree = workspace.head;
        if (input.revision) {
            this.service.revisionTree(actor, input.revision);
            tree = (this.service.store.db.prepare('SELECT tree FROM revisions WHERE id=? AND project_id=?').get(input.revision, actor.projectId) as { tree: string }).tree;
        }
        const data = { tree, revision: input.revision || null };
        return { ...data, snapshot: this.save(actor, 'snapshot', data) };
    }
    checkHead(actor: Actor, expectedHead?: string) {
        if (expectedHead && this.service.workspace(actor).head !== expectedHead) agentFault('PREVIEW_CHANGED', 'Draft changed; obtain a new preview before continuing.', 'repeat_preview', 409);
    }
    tree(source: { tree: string }): Tree { return this.service.store.tree(source.tree); }
    page(actor: Actor, input: { cursor?: string; limit?: number; maxBytes?: number }, items: unknown[], metadata: Record<string, unknown> = {}, purpose = 'read') {
        let offset = 0;
        if (input.cursor) {
            const saved = this.load(actor, input.cursor, 'page:' + purpose);
            items = saved.items; offset = saved.offset; metadata = saved.metadata;
        }
        if (purpose === 'read') this.checkHead(actor, metadata.expectedHead as string | undefined);
        const limit = input.limit || 20, budget = input.maxBytes || 12000;
        const selected: unknown[] = [];
        let bytes = Buffer.byteLength(JSON.stringify(metadata)) + 400;
        if (bytes > budget) agentFault('RESULT_METADATA_TOO_LARGE', 'Response metadata exceeds maxBytes.', 'increase_budget_or_narrow_read', 413);
        while (offset < items.length && selected.length < limit) {
            const size = Buffer.byteLength(JSON.stringify(items[offset]));
            if (bytes + size > budget) {
                if (!selected.length) agentFault('RESULT_ITEM_TOO_LARGE', 'One result exceeds maxBytes. Request fewer facets/fields, a field range, or a larger maxBytes.', 'narrow_read', 413);
                break;
            }
            selected.push(items[offset++]); bytes += size + 1;
        }
        const complete = offset >= items.length;
        const next = complete ? null : this.save(actor, 'page:' + purpose, { items, offset, metadata });
        return { ...metadata, items: selected, totalCount: items.length, complete, next, bounds: { limit, maxBytes: budget } };
    }
    metadata(entity: Entity) {
        return { id: entity.id, title: entity.title.slice(0, 200), path: entity.path.slice(0, 500), kind: entity.kind, ...entity.title.length > 200 || entity.path.length > 500 ? { metadataTruncated: true } : {}, ...'collection' in entity ? { collection: entity.collection } : {} };
    }
    project(entity: Entity, fields: string[]) {
        const result: Record<string, unknown> = this.metadata(entity);
        if (entity.kind !== 'object') return result;
        const values: Record<string, unknown> = {}, omitted: { field: string; bytes: number; read: unknown }[] = [];
        let totalBytes = 0;
        for (const field of fields) {
            const value = entity.fields[field];
            if (value === undefined) continue;
            const bytes = Buffer.byteLength(JSON.stringify(value));
            if (bytes > 1500 || totalBytes + bytes > 3000) omitted.push({ field, bytes, read: { ids: [entity.id], field, offset: 0 } });
            else { values[field] = value; totalBytes += bytes; }
        }
        result.fields = values;
        const absent = fields.filter(field => !['id','title','path','kind','collection'].includes(field) && !Object.hasOwn(entity.fields, field));
        if (absent.length) result.absent = absent;
        if (omitted.length) result.omitted = omitted;
        return result;
    }
    section(actor: Actor, source: { tree: string; snapshot: string; revision: string | null }, id: string, body: string, start: number, end: number, title: string) {
        return { title: title.slice(0, 200), length: end - start, section: this.save(actor, 'section', { source, id, start, end }), read: { ids: [id], field: 'body', snapshot: source.snapshot, offset: start, length: Math.min(2000, end - start) } };
    }
}
