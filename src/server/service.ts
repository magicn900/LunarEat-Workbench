import { applyMutationOperation, prepareMutation } from './mutations.js';
import { projectState, writableProject } from './projectState.js';
import { createHmac, randomUUID } from 'node:crypto';
import { BoundedCache } from './cache.js';
import { reviewChanges, restoreTargets, type DiscardTarget } from '../shared/review.js';
import { documentSchemaVersion, normalizeEmbeds } from '../shared/embeds.js';
import { Control, type WriteInput } from './control.js';
import { History } from './history.js';
import { deletionBlockers } from '../shared/deletion.js';
import { Step, Transform } from '@milkdown/prose/transform';
import { entitySchema, operationSchema, safePath, equal, diffTrees, diagnostics, mergeTrees, references, viewReferences, serialize, type Actor, type Tree, type Entity } from '../shared/model.js';
import { Fault, requireScope } from './auth.js';
import type { Store } from './store.js';
import type { Codec } from './codec.js';
export type Operation = {
    type: 'put';
    entity: Entity;
    expected: Entity | null;
} | {
    type: 'delete';
    id: string;
    expected: Entity;
} | {
    type: 'field';
    id: string;
    key: string;
    expected: unknown;
    value: unknown;
} | {
    type: 'patch';
    id: string;
    before: string;
    after: string;
} | {
    type: 'directory';
    from: string;
    to: string | null;
    head: string;
};
export type PublicationInput = { requestId: string; head: string; main: string; title: string; description: string };
export type PreparedPublication = { head: string; main: string; title: string; tree: string; revision: string };
export class Service {
    readonly control: Control;
    readonly timeline: History;
    private agentGroup: string | null = null;
    private readonly snapshotKey = randomUUID() + randomUUID();
    private readonly diagnosticCache = new BoundedCache<string[]>(2 * 1024 * 1024, 256);
    private readonly preparing = new Set<string>();
    private readonly changeCache = new BoundedCache<{ diff: ReturnType<typeof diffTrees>; review: ReturnType<typeof reviewChanges> }>(16 * 1024 * 1024, 256);
    constructor(readonly store: Store, readonly codec: Codec) { this.recover(); this.control = new Control(store); this.timeline = new History(store); }
    execute<T>(actor: Actor, input: WriteInput, operation: () => T, transactional = true) {
        writableProject(this.store, actor.projectId);
        const workspace = this.workspace(actor);
        const wasActive = this.control.current(workspace.id)?.status === 'active';
        const writeSessionId = this.control.prepare(actor,workspace.id,input);
        try { const run = () => {
            this.control.guard(actor,workspace.id,writeSessionId);
            const previous = this.agentGroup;
            this.agentGroup = writeSessionId ? 'agent:' + writeSessionId : null;
            try { return { ...operation(), ...(writeSessionId ? { writeSessionId } : {}) }; }
            finally { this.agentGroup = previous; }
        }; return transactional ? this.store.db.transaction(run)() : run(); } catch(error) {
            if(writeSessionId && !wasActive) {
                this.store.db.prepare("UPDATE write_sessions SET status='released' WHERE id=? AND status='active'").run(writeSessionId);
                this.control.event(actor,workspace.id);
            }
            throw error;
        }
    }
    historyStep(actor: Actor, input: { requestId: string; direction: 'undo'|'redo'; scope?: string; groupId?: string }) {
        requireScope(actor,'workspace.write');
        return this.once(actor,input.requestId,() => {
            const workspace = this.workspace(actor), current = this.store.tree(workspace.head);
            const result = this.timeline.candidate(workspace.id,current,input.direction,input.scope,input.groupId);
            const removed = new Set(Object.keys(current).filter(id => !result.tree[id]));
            if(deletionBlockers(result.tree,removed).length) throw new Fault(409,'后续引用阻止撤销或重做，请先解除引用');
            const written = this.write(actor,workspace,result.tree,'history:' + input.requestId);
            this.timeline.mark(result.entry,input.direction);
            for(const id of new Set([...Object.keys(current),...Object.keys(result.tree)])) this.syncDocument(workspace.id,id,result.tree[id],actor.sessionId);
            return written;
        });
    }
    workspace(actor: Actor) {
        projectState(this.store, actor.projectId);
        const { db } = this.store;
        let row = db.prepare('SELECT * FROM workspaces WHERE user_id=? AND project_id=?').get(actor.userId, actor.projectId) as any;
        if (!row) {
            const base = this.store.main(actor.projectId), revision = db.prepare('SELECT * FROM revisions WHERE id=? AND project_id=?').get(base, actor.projectId) as any;
            if (!revision)
                throw new Fault(409, '项目未初始化');
            db.prepare('INSERT INTO workspaces VALUES (?,?,?,?,?,0)').run(randomUUID(), actor.userId, actor.projectId, base, revision.tree);
            row = db.prepare('SELECT * FROM workspaces WHERE user_id=? AND project_id=?').get(actor.userId, actor.projectId);
        }
        return row;
    }
    private snapshotToken(workspaceId: string, head: string) {
        return head + '.' + createHmac('sha256', this.snapshotKey).update(workspaceId + ':' + head).digest('hex');
    }
    snapshot(actor: Actor, since?: string) {
        requireScope(actor, 'workspace.read');
        const workspace = this.workspace(actor);
        const previous = since?.split('.')[0];
        const delta = !!previous && since === this.snapshotToken(workspace.id, previous) && !!this.store.db.prepare('SELECT 1 FROM trees WHERE id=?').get(previous);
        const changes = delta ? this.store.changed(previous!, workspace.head) : null;
        const tree: Tree = changes ? Object.fromEntries(changes.map(id => [id, this.store.entity(workspace.head, id)]).filter((entry): entry is [string, Entity] => !!entry[1])) : this.store.tree(workspace.head);
        let issues = this.diagnosticCache.get(workspace.head);
        if (!issues) {
            issues = diagnostics(changes ? this.store.tree(workspace.head) : tree, true);
            this.diagnosticCache.set(workspace.head, issues, JSON.stringify(issues).length * 2 + 128);
        }
        return { control: this.control.publicState(workspace.id), workspace, tree, delta, cursor: this.snapshotToken(workspace.id, workspace.head), removed: changes?.filter(id => !tree[id]) || [], project: projectState(this.store, actor.projectId), main: this.store.main(actor.projectId), diagnostics: [...issues], actor: { username: actor.username, userId: actor.userId, projectId: actor.projectId, canSync: actor.canSync, scopes: actor.scopes, administrator: !!actor.administrator }, seq: this.sequence() };
    }
    sequence() { return (this.store.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get() as any).seq as number; }
    revisionTree(actor: Actor, revision: string): Tree { const row = this.store.db.prepare('SELECT tree FROM revisions WHERE id=? AND project_id=?').get(revision, actor.projectId) as any; if (!row)
        throw new Fault(404, '正式版本不存在'); return this.store.tree(row.tree); }
    once<T>(actor: Actor, requestId: string, operation: () => T): T {
        writableProject(this.store, actor.projectId);
        if (!requestId || requestId.length > 150)
            throw new Fault(400, '必须提供有效 requestId');
        const key = actor.userId + ':' + actor.sessionId + ':' + requestId;
        return this.store.db.transaction(() => { const cached = this.store.db.prepare('SELECT result FROM requests WHERE key=?').get(key) as any; if (cached)
            return JSON.parse(cached.result); const result = operation(); this.store.db.prepare('INSERT INTO requests VALUES (?,?)').run(key, JSON.stringify(result)); return result; })();
    }
    write(actor: Actor, workspace: any, tree: Tree, groupId: string, selected?: readonly string[]) {
        if (this.agentGroup && !groupId.startsWith('history:') && !groupId.startsWith('undo:')) groupId = this.agentGroup;
        const errors = diagnostics(tree, false, selected);
        if (errors.length)
            throw new Fault(422, '数据校验失败', errors);
        const head = selected ? this.store.updateObjects(workspace.head, Object.fromEntries(selected.map(id => [id, tree[id]]))) : this.store.putTree(tree, workspace.head), id = randomUUID();
        if (head === workspace.head)
            return { head, version: workspace.version, id: null };
        groupId = this.timeline.group(workspace.id, groupId, workspace.head);
        this.store.db.prepare('UPDATE workspaces SET head=?,version=version+1 WHERE id=?').run(head, workspace.id);
        this.store.db.prepare('INSERT INTO operations VALUES (?,?,?,?,?,?,?)').run(id, workspace.id, JSON.stringify({ username: actor.username, kind: actor.kind, sessionId: actor.sessionId }), groupId, workspace.head, head, new Date().toISOString());
        this.timeline.record(workspace.id,groupId,workspace.head,head);
        this.store.emit(actor.projectId, workspace.id, 'workspace', { head, version: workspace.version + 1, groupId, actor: { username: actor.username, kind: actor.kind } });
        return { head, version: workspace.version + 1, id };
    }
    mutate(actor: Actor, requestId: string, operations: Operation[], groupId = requestId) {
        requireScope(actor, 'workspace.write');
        operations = operations.map(operation => operationSchema.parse(operation));
        if (!operations.length || operations.length > 500)
            throw new Fault(400, '变更组需要 1–500 个操作');
        return this.once(actor, requestId, () => {
            const workspace = this.workspace(actor);
            if (operations.every(operation => operation.type === 'field' || operation.type === 'patch')) {
                const tree = this.store.view(workspace.head), bodies = new Set<string>();
                const selected = [...new Set(operations.map(operation => (operation as Extract<Operation, { type: 'field' | 'patch' }>).id))];
                for (const operation of operations) applyMutationOperation(tree, workspace.head, operation, this.codec, bodies);
                const result = this.write(actor, workspace, tree, groupId, selected);
                for (const id of bodies) this.syncDocument(workspace.id, id, tree[id], actor.sessionId);
                return result;
            }
            const { tree, bodies } = prepareMutation(this.store.tree(workspace.head), workspace.head, operations, this.codec);
            const result = this.write(actor, workspace, tree, groupId);
            for (const id of bodies)
                this.syncDocument(workspace.id, id, tree[id], actor.sessionId);
            return result;
        });
    }
    syncDocument(workspaceId: string, id: string, entity: Entity | undefined, clientId: string) {
        const row = this.store.db.prepare('SELECT * FROM documents WHERE workspace_id=? AND entity_id=?').get(workspaceId, id) as any;
        if (entity?.kind !== 'object') {
            this.store.db.prepare('DELETE FROM documents WHERE workspace_id=? AND entity_id=?').run(workspaceId, id);
            this.store.db.prepare('DELETE FROM steps WHERE workspace_id=? AND entity_id=?').run(workspaceId, id);
            return;
        }
        if (row && row.body.trimEnd() === entity.body.trimEnd()) {
            const normalized = normalizeEmbeds(this.codec.schema.nodeFromJSON(JSON.parse(row.doc)));
            if (normalized.steps.length) this.store.db.transaction(() => this.saveSteps(workspaceId, id, row.version, normalized.steps.map(step => step.toJSON()), 'schema-upgrade', row.body, normalized.doc.toJSON()))();
            return;
        }
        const next = this.codec.parse(entity.body);
        if (!row) {
            this.store.db.prepare('INSERT INTO documents VALUES (?,?,?,?,?)').run(workspaceId, id, 0, entity.body, JSON.stringify(next.toJSON()));
            return;
        }
        const previous = this.codec.schema.nodeFromJSON(JSON.parse(row.doc));
        if (previous.eq(next))
            return;
        const start = previous.content.findDiffStart(next.content), end = previous.content.findDiffEnd(next.content);
        if (start === null || !end)
            return;
        const overlap = start - Math.min(end.a, end.b);
        const transform = new Transform(previous).replace(start, end.a + Math.max(0, overlap), next.slice(start, end.b + Math.max(0, overlap)));
        const steps = transform.steps.map(step => step.toJSON());
        this.saveSteps(workspaceId, id, row.version, steps, clientId, entity.body, transform.doc.toJSON());
    }
    saveSteps(workspaceId: string, id: string, version: number, steps: unknown[], clientId: string, body: string, doc: unknown) {
        this.store.db.prepare('UPDATE documents SET version=?,body=?,doc=? WHERE workspace_id=? AND entity_id=?').run(version + steps.length, body, JSON.stringify(doc), workspaceId, id);
        for (let index = 0; index < steps.length; index++)
            this.store.db.prepare('INSERT INTO steps VALUES (?,?,?,?,?)').run(workspaceId, id, version + index, JSON.stringify(steps[index]), clientId);
    }
    document(actor: Actor, id: string, since?: number) {
        requireScope(actor, 'workspace.read');
const workspace = this.workspace(actor), entity = this.store.entity(workspace.head, id);
        if (entity?.kind !== 'object')
            throw new Fault(404, '页面不存在');
        this.syncDocument(workspace.id, id, entity, 'system');
        const row = this.store.db.prepare('SELECT * FROM documents WHERE workspace_id=? AND entity_id=?').get(workspace.id, id) as any;
        const steps = since === undefined ? [] : this.store.db.prepare('SELECT * FROM steps WHERE workspace_id=? AND entity_id=? AND version>=? ORDER BY version').all(workspace.id, id, since) as any[];
        return { schemaVersion: documentSchemaVersion, version: row.version, doc: JSON.parse(row.doc), body: entity.body, steps: steps.map(step => JSON.parse(step.steps)), clientIds: steps.map(step => step.client_id) };
    }
    textSteps(actor: Actor, id: string, input: {
        requestId: string;
        version: number;
        steps: unknown[];
        clientId: string;
        groupId: string;
    }) {
        requireScope(actor, 'workspace.write');
        return this.once(actor, input.requestId, () => {
            const workspace = this.workspace(actor), tree = this.store.view(workspace.head), entity = tree[id];
            if (entity?.kind !== 'object')
                throw new Fault(404, '页面不存在');
            const current = this.document(actor, id, input.version);
            if (current.version !== input.version)
                throw new Fault(409, '文档有新操作', current);
            let doc = this.codec.schema.nodeFromJSON(current.doc);
            for (const json of input.steps) {
                const result = Step.fromJSON(this.codec.schema, json).apply(doc);
                if (result.failed || !result.doc)
                    throw new Fault(409, '文本操作无法应用', result.failed);
                doc = result.doc;
            }
            doc.check();
            entity.body = this.codec.serialize(doc);
            const result = this.write(actor, workspace, tree, input.groupId, [id]);
            this.saveSteps(workspace.id, id, current.version, input.steps, input.clientId, entity.body, doc.toJSON());
            return { ...result, document: this.document(actor, id, input.version) };
        });
    }
    private describeChange(before: string, after: string) {
        const key = before + ':' + after;
        const cached = this.changeCache.get(key);
        if (cached) return structuredClone(cached);
        const trees = this.store.comparison(before, after);
        const result = { diff: diffTrees(trees.before, trees.after), review: reviewChanges(trees.before, trees.after) };
        this.changeCache.set(key, result, JSON.stringify(result).length * 4 + 1024);
        return structuredClone(result);
    }
    history(actor: Actor) {
        requireScope(actor,'workspace.read');
        return (this.store.db.prepare('SELECT * FROM history_entries WHERE workspace_id=? ORDER BY changed DESC LIMIT 150').all(this.workspace(actor).id) as any[]).map(entry => {
            const operation = this.store.db.prepare('SELECT actor FROM operations WHERE workspace_id=? AND group_id=? ORDER BY rowid DESC LIMIT 1').get(entry.workspace_id,entry.group_id) as any;
            const writeSession = entry.group_id.startsWith('agent:') ? this.store.db.prepare('SELECT status FROM write_sessions WHERE id=?').get(entry.group_id.slice(6).split(':segment:')[0]) as any : null;
            return {writeState:writeSession?.status,...entry,id:entry.group_id,actor:JSON.parse(operation?.actor || '{}'),diff:this.describeChange(entry.before_tree,entry.after_tree).diff};
        });
    }
    undo(actor: Actor, requestId: string, groupId: string) {
        return this.historyStep(actor,{requestId,direction:'undo',groupId});
    }
    preview(actor: Actor) {
        requireScope(actor, 'workspace.read');
        const workspace = this.workspace(actor), main = this.store.main(actor.projectId), base = this.revisionTree(actor, workspace.base), ours = this.store.tree(workspace.head), theirs = this.revisionTree(actor, main), merged = mergeTrees(base, ours, theirs);
        const differences = diffTrees(base, ours);
        const raw = [...new Set(differences.map(item => item.id))].map(id => ({ id, title: (ours[id] || base[id]).path, kind: '文件', property: '原始文本', before: base[id] ? serialize(base[id]) : '', after: ours[id] ? serialize(ours[id]) : '' }));
        return { head: workspace.head, main, base: workspace.base, raw, diff: differences, review: reviewChanges(base, ours), conflicts: merged.conflicts, diagnostics: diagnostics(merged.tree, true), candidate: merged.tree, theirs, ours };
    }
    discardPreview(actor: Actor, input: { head: string; base: string; main: string; targets: DiscardTarget[] }) {
        requireScope(actor, 'workspace.read');
        const workspace = this.workspace(actor);
        if (workspace.head !== input.head || workspace.base !== input.base || this.store.main(actor.projectId) !== input.main) throw new Fault(409, '草稿或正式版本已更新，请重新检查修改');
        const base = this.revisionTree(actor, workspace.base), current = this.store.tree(workspace.head);
        const targets = [...new Map(input.targets.map(target => [JSON.stringify([target.id, target.key]), target])).values()];
        const dependencies: { id: string; title: string; reason: string }[] = [];
        let tree: Tree;
        for (let attempt = 0; attempt <= Object.keys(current).length + Object.keys(base).length; attempt++) {
            try { tree = restoreTargets(base, current, targets); } catch (error: any) { throw new Fault(409, error.message); }
            const removed = new Set(Object.keys(current).filter(id => !tree[id]));
            const required = new Map<string, string>();
            for (const entity of deletionBlockers(tree, removed)) required.set(entity.id, '依赖被取消的内容；需要丢弃此文件全部草稿修改');
            for (const entity of Object.values(tree)) {
                const links = references(entity);
                if (entity.kind === 'object') {
                    links.push(...viewReferences(entity));
                    const collection = entity.collection ? tree[entity.collection] || base[entity.collection] : null;
                    if (collection?.kind === 'collection') links.push(...collection.fields.filter(field => field.type === 'reference').map(field => String(entity.fields[field.key] || '')));
                }
                if ((entity.kind === 'object' || entity.kind === 'view') && entity.collection) links.push(entity.collection);
                for (const id of links) if (!tree[id] && base[id]) required.set(id, '恢复的内容依赖此文件；需要同时恢复');
            }
            const additional = [...required].filter(([id]) => !targets.some(target => target.id === id && !target.key) && !equal(base[id], current[id]));
            if (!additional.length) {
                const issues = diagnostics(tree);
                if (targets.length > 500) issues.push('关联修改超过单次操作上限，请分批整理后重试');
                if (deletionBlockers(tree, removed).length) issues.push('仍有引用依赖，请先调整关联内容');
                return { head: input.head, base: input.base, main: input.main, targets, dependencies, issues, changes: reviewChanges(current, tree) };
            }
            for (const [id, reason] of additional) { targets.push({ id }); dependencies.push({ id, title: (current[id] || base[id]).title, reason }); }
        }
        throw new Fault(409, '关联内容无法安全恢复，请手动整理');
    }
    discard(actor: Actor, input: { requestId: string; head: string; base: string; main: string; targets: DiscardTarget[] }) {
        requireScope(actor, 'workspace.write');
        return this.once(actor, input.requestId, () => {
            const plan = this.discardPreview(actor, input);
            if (plan.dependencies.length) throw new Fault(409, '需要明确确认关联内容的丢弃范围', plan);
            if (plan.issues.length) throw new Fault(422, '丢弃后会破坏内容结构，请先调整关联内容', plan.issues);
            const workspace = this.workspace(actor), current = this.store.tree(workspace.head);
            const tree = restoreTargets(this.revisionTree(actor, workspace.base), current, plan.targets);
            const groupId = this.agentGroup || 'discard:' + input.requestId;
            const result = this.write(actor, workspace, tree, groupId);
            for (const id of new Set([...Object.keys(current), ...Object.keys(tree)])) if (!equal(current[id], tree[id])) this.syncDocument(workspace.id, id, tree[id], actor.sessionId);
            return { ...result, groupId };
        });
    }
    refresh(actor: Actor, input: {
        requestId: string;
        head: string;
        main: string;
        resolutions?: Record<string, 'ours' | 'theirs'>;
    }) {
        requireScope(actor, 'workspace.write');
        return this.once(actor, input.requestId, () => {
            const preview = this.preview(actor);
            if (preview.head !== input.head || preview.main !== input.main)
                throw new Fault(409, '工作区或 main 已更新，请重新预览');
            const candidate = preview.candidate;
            for (const conflict of preview.conflicts) {
                const choice = input.resolutions?.[conflict];
                if (!choice)
                    throw new Fault(409, '需要解决合并冲突', preview.conflicts);
                const parts = conflict.split('/').slice(1);
                let source: any = choice === 'ours' ? preview.ours : preview.theirs;
                for (const part of parts)
                    source = source?.[part];
                let target: any = candidate;
                for (const part of parts.slice(0, -1))
                    target = target[part] ??= {};
                if (source === undefined)
                    delete target[parts.at(-1)!];
                else
                    target[parts.at(-1)!] = source;
            }
            const workspace = this.workspace(actor), result = this.write(actor, workspace, candidate, 'refresh:' + input.requestId);
            this.store.db.prepare('UPDATE workspaces SET base=? WHERE id=?').run(preview.main, workspace.id);
            for (const entity of Object.values(candidate))
                this.syncDocument(workspace.id, entity.id, entity, 'refresh');
            this.store.emit(actor.projectId, workspace.id, 'workspace', { base: preview.main });
            return result;
        });
    }
    async stagePublication<Result>(actor: Actor, input: PublicationInput, write: WriteInput, complete: (prepared: PreparedPublication | undefined, write: WriteInput) => Result): Promise<Result> {
        writableProject(this.store, actor.projectId);
        requireScope(actor, 'workspace.write');
        requireScope(actor, 'design.publish');
        if (this.store.db.prepare('SELECT 1 FROM publications WHERE id=? AND project_id=?').get(actor.userId + ':' + input.requestId, actor.projectId)) return complete(undefined, write);
        if (this.preparing.has(actor.projectId) || this.preparing.size >= 2) throw new Fault(429, '正在准备发布，请稍后重试');
        const workspace = this.workspace(actor);
        const previousSession = this.control.current(workspace.id)?.id;
        const writeSessionId = this.control.prepare(actor, workspace.id, write);
        this.control.guard(actor, workspace.id, writeSessionId);
        this.preparing.add(actor.projectId);
        try {
            const preview = this.publicationPreview(actor, input);
            const tree = this.store.putTree(preview.candidate, workspace.head);
            const revision = await this.store.commitAsync(actor.projectId, preview.candidate, preview.main, input.title);
            this.control.guard(actor, workspace.id, writeSessionId);
            return complete({ head: input.head, main: input.main, title: input.title, tree, revision }, { ...write, ...(writeSessionId ? { writeSessionId } : {}) });
        } catch (error) {
            if (writeSessionId && previousSession !== writeSessionId) {
                this.store.db.prepare("UPDATE write_sessions SET status='released' WHERE id=? AND status='active'").run(writeSessionId);
                this.control.event(actor, workspace.id);
            }
            throw error;
        } finally { this.preparing.delete(actor.projectId); }
    }
    private publicationPreview(actor: Actor, input: PublicationInput) {
        if (!input.title.trim()) throw new Fault(400, '请输入发布标题');
        const preview = this.preview(actor);
        if (preview.head !== input.head || preview.main !== input.main) throw new Fault(409, '预览已过期，请刷新');
        if (!preview.diff.length) throw new Fault(400, '没有需要发布的修改');
        if (preview.conflicts.length || preview.diagnostics.length) throw new Fault(409, '请先解决冲突或校验问题', { conflicts: preview.conflicts, diagnostics: preview.diagnostics });
        return preview;
    }
    publish(actor: Actor, input: PublicationInput, prepared?: PreparedPublication) {
        writableProject(this.store, actor.projectId);
        requireScope(actor, 'design.publish');
        if (!input.title.trim())
            throw new Fault(400, '请输入发布标题');
        const id = actor.userId + ':' + input.requestId;
        const existing = this.store.db.prepare('SELECT * FROM publications WHERE id=? AND project_id=?').get(id, actor.projectId) as any;
        if (existing) {
            this.recover();
            return this.store.db.prepare('SELECT * FROM publications WHERE id=?').get(id);
        }
        const preview = this.publicationPreview(actor, input);
        const workspace = this.workspace(actor), tree = this.store.putTree(preview.candidate, workspace.head);
        if (prepared && (prepared.tree !== tree || prepared.head !== input.head || prepared.main !== input.main || prepared.title !== input.title)) throw new Fault(409, '发布准备已失效，请重新预览');
        const revision = prepared?.revision || this.store.commit(actor.projectId, preview.candidate, preview.main, input.title), created = new Date().toISOString();
        this.store.db.prepare('INSERT INTO publications VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, actor.projectId, workspace.id, preview.main, revision, tree, input.title, input.description, JSON.stringify({ username: actor.username, kind: actor.kind }), 'prepared', created);
        this.store.git(actor.projectId, ['update-ref', 'refs/heads/main', revision, preview.main]);
        this.finishPublication(id);
        return this.store.db.prepare('SELECT * FROM publications WHERE id=?').get(id);
    }
    finishPublication(id: string) {
        this.store.db.transaction(() => {
            const row = this.store.db.prepare('SELECT * FROM publications WHERE id=?').get(id) as any;
            if (row.state === 'done')
                return;
            this.store.db.prepare('INSERT OR IGNORE INTO revisions VALUES (?,?,?,?,?)').run(row.revision, row.project_id, row.tree, row.old_main, row.created);
            this.store.db.prepare('UPDATE workspaces SET base=?,head=?,version=version+1 WHERE id=?').run(row.revision, row.tree, row.workspace_id);
            this.store.db.prepare("UPDATE publications SET state='done' WHERE id=?").run(id);
            const documents = this.store.db.prepare('SELECT entity_id FROM documents WHERE workspace_id=?').all(row.workspace_id) as { entity_id: string }[];
            for (const document of documents) this.syncDocument(row.workspace_id, document.entity_id, this.store.entity(row.tree, document.entity_id), 'publish');
            this.store.emit(row.project_id, row.workspace_id, 'workspace', { published: row.revision });
            this.store.emit(row.project_id, null, 'publication', { id, revision: row.revision });
        })();
    }
    recover() { for (const row of this.store.db.prepare("SELECT * FROM publications WHERE state='prepared'").all() as any[]) {
        const main = this.store.main(row.project_id);
        if (main === row.old_main)
            this.store.git(row.project_id, ['update-ref', 'refs/heads/main', row.revision, row.old_main]);
        else if (main !== row.revision)
            throw new Error('发布恢复失败：main 被外部修改，停止写入');
        this.finishPublication(row.id);
    } }
    changes(actor: Actor) {
        requireScope(actor, 'workspace.read');
        return (this.store.db.prepare("SELECT * FROM publications WHERE project_id=? AND state='done' ORDER BY rowid DESC").all(actor.projectId) as any[]).map(row => {
            const previous = this.store.db.prepare('SELECT tree FROM revisions WHERE id=? AND project_id=?').get(row.old_main, actor.projectId) as { tree: string } | undefined;
            if (!previous) throw new Fault(404, '正式版本不存在');
            return { ...row, actor: JSON.parse(row.actor), ...this.describeChange(previous.tree, row.tree), confirmations: (this.store.db.prepare('SELECT * FROM confirmations WHERE publication_id=? ORDER BY rowid DESC').all(row.id) as any[]).map(item => ({ ...item, actor: JSON.parse(item.actor) })) };
        });
    }
    confirm(actor: Actor, input: {
        requestId: string;
        ids: string[];
        repository: string;
        commit: string;
        note: string;
        active: boolean;
    }) {
        requireScope(actor, 'design.sync');
        if (!input.ids.length || !input.repository.trim() || !input.commit.trim() || !input.note.trim())
            throw new Fault(400, '请填写仓库、commit 和确认说明');
        return this.once(actor, input.requestId, () => {
            for (const id of input.ids) {
                if (!this.store.db.prepare("SELECT id FROM publications WHERE id=? AND project_id=? AND state='done'").get(id, actor.projectId))
                    throw new Fault(404, '设计变更不存在');
                this.store.db.prepare('UPDATE confirmations SET active=0 WHERE publication_id=?').run(id);
                this.store.db.prepare('INSERT INTO confirmations VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), id, input.repository, input.commit, input.note, JSON.stringify({ username: actor.username, kind: actor.kind }), input.active ? 1 : 0, new Date().toISOString());
            }
            this.store.emit(actor.projectId, null, 'confirmation', { ids: input.ids });
            return { ok: true };
        });
    }
    notes(actor: Actor, query = '') { requireScope(actor, 'inspiration.read'); return (this.store.db.prepare('SELECT * FROM notes WHERE project_id=? ORDER BY updated DESC').all(actor.projectId) as any[]).map(row => ({ ...row, tags: JSON.parse(row.tags) })).filter(row => (row.title + ' ' + row.body + ' ' + row.tags.join(' ')).includes(query)); }
    note(actor: Actor, input: {
        requestId: string;
        id?: string;
        version?: number;
        title: string;
        body: string;
        tags: string[];
        remove?: boolean;
    }) {
        requireScope(actor, 'inspiration.write');
        return this.once(actor, input.requestId, () => {
            const id = input.id || randomUUID(), previous = this.store.db.prepare('SELECT * FROM notes WHERE id=? AND project_id=?').get(id, actor.projectId) as any;
            if (input.id && (!previous || previous.version !== input.version))
                throw new Fault(409, '便签已修改或删除，请重新读取');
            if (!input.title.trim())
                throw new Fault(400, '便签标题不能为空');
            const now = new Date().toISOString();
            if (input.remove)
                this.store.db.prepare('DELETE FROM notes WHERE id=? AND project_id=?').run(id, actor.projectId);
            else
                this.store.db.prepare('INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,body=excluded.body,tags=excluded.tags,editor=excluded.editor,version=excluded.version,updated=excluded.updated').run(id, actor.projectId, input.title, input.body, JSON.stringify(input.tags), previous?.author || actor.username, actor.username, (previous?.version || 0) + 1, previous?.created || now, now);
            this.store.emit(actor.projectId, null, 'inspiration', { id, actor: { username: actor.username, kind: actor.kind } });
            return { id, version: (previous?.version || 0) + 1 };
        });
    }
    promote(actor: Actor, input: {
        requestId: string;
        id: string;
        version: number;
    }) {
        requireScope(actor, 'inspiration.read');
        requireScope(actor, 'workspace.write');
        return this.once(actor, input.requestId, () => {
            const note = this.store.db.prepare('SELECT * FROM notes WHERE id=? AND project_id=?').get(input.id, actor.projectId) as any;
            if (!note || note.version !== input.version)
                throw new Fault(409, '便签已变化，请重新读取');
            const workspace = this.workspace(actor), tree = this.store.tree(workspace.head), id = randomUUID();
            tree[id] = { id, kind: 'object', path: '灵感转入/' + id + '.md', title: note.title, collection: null, fields: {}, body: this.codec.serialize(this.codec.parse(note.body)) };
            return { ...this.write(actor, workspace, tree, 'promote:' + input.requestId), entityId: id };
        });
    }
    search(actor: Actor, query: string) { requireScope(actor, 'workspace.read'); return Object.values(this.store.tree(this.workspace(actor).head)).filter(entity => (entity.title + ' ' + entity.path + ' ' + (entity.kind === 'object' ? entity.body + JSON.stringify(entity.fields) : '')).includes(query)); }
    events(actor: Actor, since: number) {
        const workspace = this.workspace(actor);
        return (this.store.db.prepare("SELECT * FROM events WHERE seq>? AND project_id=? AND (workspace_id IS NULL OR workspace_id=?) AND ((kind='inspiration' AND ?) OR (kind<>'inspiration' AND ?)) ORDER BY seq LIMIT 500").all(since, actor.projectId, workspace.id, Number(actor.scopes.includes('inspiration.read')), Number(actor.scopes.includes('workspace.read'))) as any[]).map(row => ({ ...row, payload: JSON.parse(row.payload) }));
    }
}
