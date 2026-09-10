import type { FastifyInstance } from 'fastify';
import { agentSchemas, parseAgentInput, describeAgentCommand, agentDescriptions, type AgentCommand } from '../shared/agentContract.js';
import { equal, type Actor, type Tree } from '../shared/model.js';
import { requireScope } from './auth.js';
import { projectState } from './projectState.js';
import type { Service, PreparedPublication } from './service.js';
import { AgentContext, agentFault } from './agentContext.js';
import { AgentReads } from './agentReads.js';
import { AgentEdits } from './agentEdits.js';
import type { MergeConflict } from '../shared/workspaceMerge.js';

export class AgentCollaboration {
    readonly context: AgentContext;
    readonly reads: AgentReads;
    readonly edits: AgentEdits;
    constructor(readonly service: Service) { this.context = new AgentContext(service); this.reads = new AgentReads(this.context); this.edits = new AgentEdits(this.context, this.reads); }
    differences(before: Tree, after: Tree, objectId?: string) {
        return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(id => (!objectId || id === objectId) && !equal(before[id], after[id])).map(id => {
            const previous = before[id], entity = after[id];
            const fields = [...new Set([...Object.keys(previous || {}), ...Object.keys(entity || {})])].filter(key => !equal((previous as any)?.[key], (entity as any)?.[key]));
            const compact = (value: unknown) => {
                if (value === undefined) return { exists: false };
                const text = typeof value === 'string' ? value : JSON.stringify(value);
                return text.length <= 600 ? { value, complete: true } : { sample: text.slice(0, 600), length: text.length, complete: false, next: 'read the selected field at before/after snapshot' };
            };
            return { ...this.context.metadata(entity || previous), change: !previous ? 'created' : !entity ? 'deleted' : 'updated', fields: fields.slice(0, 15).map(field => ({ field, before: compact((previous as any)?.[field]), after: compact((entity as any)?.[field]) })), complete: fields.length <= 15 };
        });
    }
    treeRef(actor: Actor, tree: string, revision: string | null = null) { return this.context.save(actor, 'snapshot', { tree, revision }); }
    mergeConflictItems(conflicts: MergeConflict[], sources: { base: string; draft: string; main: string }) {
        return conflicts.map(conflict => {
            const [id, ...parts] = conflict.path.split('/').slice(1);
            const field = parts.length === 2 && parts[0] === 'fields' ? parts[1] : parts.length === 1 && ['body','title','path'].includes(parts[0]) ? parts[0] : '$entity';
            const side = (value: unknown, snapshot: string) => {
                if (value === undefined) return { exists: false, complete: true };
                const complete = Buffer.byteLength(JSON.stringify(value)) <= 600;
                return { exists: true, complete, ...(complete ? { value } : {}), read: { ids: [id], field, snapshot, offset: 0, length: 2000 }, valuePath: field === '$entity' ? parts : [] };
            };
            const segmentsComplete = !!conflict.segments && Buffer.byteLength(JSON.stringify(conflict.segments)) <= 2000;
            return { path: conflict.path, title: conflict.title.slice(0, 200), file: conflict.file.slice(0, 500), property: conflict.property, label: conflict.label.slice(0, 200), base: side(conflict.base, sources.base), ours: side(conflict.ours, sources.draft), theirs: side(conflict.theirs, sources.main), ...(conflict.segments ? { segmentsComplete, ...(segmentsComplete ? { segments: conflict.segments } : {}) } : {}) };
        });
    }
    history(actor: Actor, input: any) {
        requireScope(actor, 'workspace.read');
        if (['undo','redo'].includes(input.action)) {
            requireScope(actor, 'workspace.write');
            if (input.actor || input.cursor) agentFault('UNSUPPORTED_PARAMETER', 'actor/cursor are list filters, not undo/redo inputs.', 'inspect_history_then_choose_id', 400);
            return this.edits.execute(actor, 'history', input, () => {
                const before = this.service.store.tree(this.service.workspace(actor).head);
                const result = this.service.historyStep(actor, { requestId: this.edits.requestKey(actor, input), direction: input.action, groupId: input.id, scope: input.objectId });
                return this.edits.receipt(actor, before, this.service.store.tree(this.service.workspace(actor).head), { ...result, snapshot: this.context.source(actor, {}).snapshot });
            });
        }
        if (input.cursor) return this.context.page(actor, input, [], {}, 'history');
        const workspace = this.service.workspace(actor);
        const entries = this.service.store.db.prepare('SELECT h.*, (SELECT actor FROM operations o WHERE o.workspace_id=h.workspace_id AND o.group_id=h.group_id ORDER BY rowid DESC LIMIT 1) origin FROM history_entries h WHERE h.workspace_id=? ORDER BY h.changed DESC').all(workspace.id) as any[];
        if (input.action === 'inspect') {
            const entry = entries.find(entry => entry.group_id === input.id);
            if (!entry) agentFault('HISTORY_NOT_FOUND', 'History group not found in this workspace.', 'list_history', 404);
            return this.context.page(actor, input, this.differences(this.service.store.tree(entry.before_tree), this.service.store.tree(entry.after_tree), input.objectId), { id: entry.group_id, state: entry.state, actor: JSON.parse(entry.origin || '{}'), before: this.treeRef(actor, entry.before_tree), after: this.treeRef(actor, entry.after_tree) }, 'history');
        }
        const selected = entries.filter(entry => !input.actor || JSON.parse(entry.origin || '{}').kind === input.actor).filter(entry => !input.objectId || !equal(this.service.store.tree(entry.before_tree)[input.objectId], this.service.store.tree(entry.after_tree)[input.objectId]));
        return this.context.page(actor, input, selected.map(entry => ({ id: entry.group_id, state: entry.state, changed: entry.changed, actor: JSON.parse(entry.origin || '{}'), next: { action: 'inspect', id: entry.group_id } })), {}, 'history');
    }
    versions(actor: Actor, input: any, prepared?: PreparedPublication) {
        requireScope(actor, 'workspace.read');
        if (input.action === 'withdraw') {
            requireScope(actor, 'workspace.write'); requireScope(actor, 'design.publish');
            return this.edits.execute(actor, 'versions', input, () => this.service.withdraw(actor, input), true, false);
        }
        if (input.action === 'sync') {
            requireScope(actor, 'design.sync');
            return this.edits.execute(actor, 'versions', input, () => this.service.confirm(actor, { ...input, requestId: this.edits.requestKey(actor, input) }), false);
        }
        if (['publish','refresh','discard'].includes(input.action)) {
            requireScope(actor, 'workspace.write'); if (input.action === 'publish') requireScope(actor, 'design.publish');
            return this.edits.execute(actor, 'versions', input, () => {
                if (input.action === 'discard') {
                    const plan = this.context.load(actor, input.plan, 'discard-plan');
                    const before = this.service.store.tree(this.service.workspace(actor).head);
                    const result = this.service.discard(actor, { ...plan, requestId: this.edits.requestKey(actor, input) });
                    return this.edits.receipt(actor, before, this.service.store.tree(this.service.workspace(actor).head), result);
                }
                const review = this.context.load(actor, input.review, 'review');
                return input.action === 'publish' ? this.service.publish(actor, { requestId: this.edits.requestKey(actor, input), head: review.head, main: review.main, title: input.title, description: input.description }, prepared) : this.service.refresh(actor, { requestId: this.edits.requestKey(actor, input), head: review.head, main: review.main, resolutions: input.resolutions });
            }, true, input.action !== 'publish');
        }
        if (input.action === 'discard-preview') {
            const review = this.context.load(actor, input.review, 'review');
            const preview = this.service.discardPreview(actor, { ...review, targets: input.targets });
            const items = [...preview.targets.map(target => ({ kind: 'target', ...target })), ...preview.dependencies.map(target => ({ kind: 'dependency', ...target })), ...preview.issues.map(issue => ({ kind: 'issue', issue }))];
            return { plan: this.context.save(actor, 'discard-plan', { head: preview.head, base: preview.base, main: preview.main, targets: preview.targets }), receipt: this.context.save(actor, 'receipt', { items }), targetCount: preview.targets.length, dependencyCount: preview.dependencies.length, issueCount: preview.issues.length, requiresConfirmation: true, ...this.context.page(actor, {}, items) };
        }
        if (input.cursor) return this.context.page(actor, input, [], {}, 'versions:' + input.action);
        if (input.action === 'review') {
            const preview = this.service.preview(actor);
            const review = this.context.save(actor, 'review', { head: preview.head, base: preview.base, main: preview.main });
            const baseTree = (this.service.store.db.prepare('SELECT tree FROM revisions WHERE id=? AND project_id=?').get(preview.base, actor.projectId) as { tree: string }).tree;
            const mainTree = (this.service.store.db.prepare('SELECT tree FROM revisions WHERE id=? AND project_id=?').get(preview.main, actor.projectId) as { tree: string }).tree;
            const sources = { base: this.treeRef(actor, baseTree, preview.base), draft: this.treeRef(actor, preview.head), main: this.treeRef(actor, mainTree, preview.main) };
            const incoming = this.differences(this.service.revisionTree(actor, preview.base), preview.theirs);
            const conflicts = this.mergeConflictItems(preview.conflictDetails, sources);
            return this.context.page(actor, input, this.differences(this.service.revisionTree(actor, preview.base), preview.ours), { review, publicationDraft: preview.publicationDraft, head: preview.head, base: preview.base, main: preview.main, conflicts: preview.conflicts.slice(0, 10), conflictsComplete: preview.conflicts.length <= 10, diagnostics: preview.diagnostics.slice(0, 10), diagnosticsComplete: preview.diagnostics.length <= 10, sources, incoming: { count: incoming.length, receipt: this.context.save(actor, 'receipt', { items: incoming }) }, conflictDetails: { count: conflicts.length, receipt: this.context.save(actor, 'receipt', { items: conflicts }) } }, 'versions:review');
        }
        const rows = this.service.store.db.prepare("SELECT * FROM publications WHERE project_id=? AND state='done' ORDER BY rowid DESC").all(actor.projectId) as any[];
        if (['inspect','confirmations'].includes(input.action)) {
            const row = rows.find(row => row.id === input.id);
            if (!row) agentFault('PUBLICATION_NOT_FOUND', 'Publication not found.', 'list_versions', 404);
            if (input.action === 'confirmations') return this.context.page(actor, input, this.service.store.db.prepare('SELECT repository,commit_id,note,actor,active,created FROM confirmations WHERE publication_id=? ORDER BY rowid DESC').all(row.id), { id: row.id }, 'versions:confirmations');
            return this.context.page(actor, input, this.differences(this.service.revisionTree(actor, row.old_main), this.service.store.tree(row.tree), input.objectId), { id: row.id, title: row.title, description: row.description, withdrawalBlocker: this.service.withdrawalBlocker(actor, row), beforeRevision: row.old_main, revision: row.revision, confirmations: { action: 'confirmations', id: row.id } }, 'versions:inspect');
        }
        return this.context.page(actor, input, rows.map(row => ({ withdrawalBlocker: this.service.withdrawalBlocker(actor, row), id: row.id, title: row.title.slice(0, 200), revision: row.revision, created: row.created, actor: JSON.parse(row.actor), synchronized: !!this.service.store.db.prepare('SELECT 1 FROM confirmations WHERE publication_id=? AND active=1 LIMIT 1').get(row.id), next: { action: 'inspect', id: row.id } })), {}, 'versions:list');
    }
    inspiration(actor: Actor, input: any) {
        if (input.action === 'write') {
            requireScope(actor, 'inspiration.write');
            return this.edits.execute(actor, 'inspiration', input, () => this.service.note(actor, { ...input, requestId: this.edits.requestKey(actor, input) }), false);
        }
        requireScope(actor, 'inspiration.read');
        if (input.action === 'promote') {
            requireScope(actor, 'workspace.write');
            return this.edits.execute(actor, 'inspiration', input, () => this.service.promote(actor, { ...input, requestId: this.edits.requestKey(actor, input) }));
        }
        if (input.cursor) return this.context.page(actor, input, [], {}, 'inspiration');
        const notes = this.service.notes(actor, input.action === 'find' ? input.query : '');
        if (input.action === 'read') {
            const note = notes.find(note => note.id === input.id);
            if (!note) agentFault('NOTE_NOT_FOUND', 'Inspiration note not found.', 'find_inspiration', 404);
            if (input.offset && input.version === undefined) agentFault('VERSION_REQUIRED', 'Continuation reads require the note version.', 'restart_note_read', 400);
            if (input.version !== undefined && input.version !== note.version) agentFault('NOTE_CHANGED', 'Note changed during reading.', 'restart_note_read');
            if (input.offset > note.body.length) agentFault('RANGE_INVALID', 'Offset exceeds note length.', 'restart_note_read', 400);
            const end = Math.min(note.body.length, input.offset + input.length);
            return { id: note.id, version: note.version, title: note.title, tags: note.tags, body: note.body.slice(input.offset, end), complete: end >= note.body.length, nextOffset: end >= note.body.length ? null : end, totalLength: note.body.length, source: 'inspiration' };
        }
        return this.context.page(actor, input, notes.map(note => ({ id: note.id, title: note.title, tags: note.tags, version: note.version })), { source: 'inspiration' }, 'inspiration');
    }
    run(actor: Actor, name: AgentCommand, input: any, prepared?: PreparedPublication): unknown {
        if (name === 'schema') return describeAgentCommand(input.name) || agentFault('SCHEMA_NOT_FOUND', 'Schema does not exist.', 'schema_index', 404);
        if (name === 'connect') {
            const workspace = this.service.store.db.prepare('SELECT id FROM workspaces WHERE user_id=? AND project_id=?').get(actor.userId, actor.projectId) as { id: string } | undefined;
            return { account: { id: actor.userId, username: actor.username }, project: projectState(this.service.store, actor.projectId), scopes: actor.scopes, control: workspace ? this.service.control.publicState(workspace.id) : null, commands: Object.keys(agentDescriptions), catalog: { command: 'find', input: { kind: 'collection' } } };
        }
        if (name === 'inspiration') return this.inspiration(actor, input);
        if (name === 'edit') return this.edits.edit(actor, input);
        if (name === 'versions') return this.versions(actor, input, prepared);
        if (name === 'history') return this.history(actor, input);
        if (name === 'control') {
            requireScope(actor, 'workspace.read');
            const workspace = this.service.workspace(actor);
            return input.action === 'status' ? { control: this.service.control.publicState(workspace.id) } : this.service.control.action(actor, workspace.id, input);
        }
        requireScope(actor, 'workspace.read');
        return this.reads[name](actor, input);
    }
}
export function registerAgentCollaboration(app: FastifyInstance, service: Service, actor: (request: any) => Actor) {
    const collaboration = new AgentCollaboration(service);
    app.post('/api/agent/:command', async request => {
        const current = actor(request);
        if (current.kind !== 'agent') agentFault('AGENT_REQUIRED', 'Use an Agent credential for collaboration tools.', 'configure_agent_credential', 403);
        const command = (request.params as { command: AgentCommand }).command;
        if (!Object.hasOwn(agentSchemas, command)) agentFault('COMMAND_NOT_FOUND', 'Unknown command.', 'help', 404);
        const input = parseAgentInput(command, request.body || {}) as any;
        if (command === 'versions' && input.action === 'publish') {
            requireScope(current, 'workspace.read'); requireScope(current, 'workspace.write'); requireScope(current, 'design.publish');
            const cached = collaboration.edits.replay(current, command, input);
            if (cached) return cached;
            const review = collaboration.context.load(current, input.review, 'review');
            const publication = { requestId: collaboration.edits.requestKey(current, input), head: review.head, main: review.main, title: input.title, description: input.description };
            return service.stagePublication(current, publication, input, (prepared, write) => collaboration.run(actor(request), command, { ...input, ...write }, prepared));
        }
        return collaboration.run(current, command, input);
    });
}
