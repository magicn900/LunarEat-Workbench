import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import { mergeTrees, type Tree } from '../shared/model.js';
import { Fault } from './auth.js';

type Entry = { workspace_id: string; group_id: string; before_tree: string; after_tree: string; state: string; changed: number; contexts: string };
export class History {
    constructor(private store: Store) {
        const existing=store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_entries'").get();

        if(existing)return;
        store.db.transaction(()=>{
        store.db.exec('CREATE TABLE IF NOT EXISTS history_entries(workspace_id TEXT NOT NULL,group_id TEXT NOT NULL,before_tree TEXT NOT NULL,after_tree TEXT NOT NULL,state TEXT NOT NULL,changed INTEGER NOT NULL,contexts TEXT NOT NULL,PRIMARY KEY(workspace_id,group_id));');
            const rows=store.db.prepare('SELECT * FROM operations ORDER BY rowid').all() as any[];
            for(const row of rows){
                if(row.group_id.startsWith('history:'))continue;
                if(row.group_id.startsWith('undo:')){
                    let group=row.group_id,depth=0;
                    while(group.startsWith('undo:')&&group.lastIndexOf(':')>4){group=group.slice(5,group.lastIndexOf(':'));depth++;}
                    const entry=store.db.prepare('SELECT * FROM history_entries WHERE workspace_id=? AND group_id=?').get(row.workspace_id,group) as Entry|undefined;
                    if(entry)this.mark(entry,depth%2?'undo':'redo');
                }else {
                    store.db.prepare("UPDATE history_entries SET state='applied' WHERE workspace_id=? AND group_id=?").run(row.workspace_id,row.group_id);
                    this.record(row.workspace_id,row.group_id,row.before_tree,row.after_tree);
                }
            }
        })();
    }
    group(workspaceId: string, requested: string, head: string) {
        if (requested.startsWith('history:') || requested.startsWith('undo:')) return requested;
        const last = this.store.db.prepare('SELECT group_id,after_tree FROM operations WHERE workspace_id=? ORDER BY rowid DESC LIMIT 1').get(workspaceId) as { group_id: string; after_tree: string } | undefined;
        if (last?.after_tree === head && (last.group_id === requested || last.group_id.startsWith(requested + ':segment:'))) return last.group_id;
        const existing = this.store.db.prepare('SELECT state FROM history_entries WHERE workspace_id=? AND group_id=?').get(workspaceId, requested) as { state: string } | undefined;
        if (existing?.state === 'applied') return requested + ':segment:' + randomUUID();
        return requested;
    }
    record(workspaceId: string, groupId: string, before: string, after: string) {
        if (groupId.startsWith('history:') || groupId.startsWith('undo:')) return;
        const existing = this.store.db.prepare('SELECT * FROM history_entries WHERE workspace_id=? AND group_id=?').get(workspaceId,groupId) as Entry | undefined;
        if (existing && existing.state !== 'applied') throw new Fault(409,'变更组已撤销，请使用新的变更组');
        const original = existing?.before_tree || before;
        const contexts = new Set<string>();
        for (const id of this.store.changed(original, after)) {
            contexts.add(id);
            for (const entity of [this.store.entity(original, id), this.store.entity(after, id)]) {
                if (!entity) continue;
                if(entity.kind === 'collection' || entity.kind === 'view' || (entity.kind === 'object' && entity.collection)) contexts.add('collections');
                if((entity.kind === 'object' || entity.kind === 'view') && entity.collection) contexts.add(entity.collection);
            }
        }
        const clock = (this.store.db.prepare('SELECT COALESCE(MAX(changed),0)+1 AS value FROM history_entries').get() as any).value;
        this.store.db.prepare("UPDATE history_entries SET state='abandoned' WHERE workspace_id=? AND state='undone'").run(workspaceId);
        this.store.db.prepare('INSERT INTO history_entries VALUES (?,?,?,?,?,?,?) ON CONFLICT(workspace_id,group_id) DO UPDATE SET after_tree=excluded.after_tree,changed=excluded.changed,contexts=excluded.contexts').run(workspaceId,groupId,original,after,'applied',clock,JSON.stringify([...contexts]));
    }
    select(workspaceId: string, direction: 'undo'|'redo', scope?: string, groupId?: string) {
        const rows = this.store.db.prepare('SELECT * FROM history_entries WHERE workspace_id=? AND state=? ORDER BY changed DESC').all(workspaceId,direction === 'undo' ? 'applied' : 'undone') as Entry[];
        return rows.find(entry => entry.before_tree!==entry.after_tree && (!groupId || entry.group_id === groupId) && (!scope || JSON.parse(entry.contexts).includes(scope)));
    }
    candidate(workspaceId: string, current: Tree, direction: 'undo'|'redo', scope?: string, groupId?: string) {
        const entry = this.select(workspaceId,direction,scope,groupId);
        if(!entry) throw new Fault(409,direction === 'undo' ? '当前范围没有可撤销的操作' : '当前范围没有可重做的操作');
        const interleaved = this.store.db.prepare('SELECT 1 FROM operations WHERE workspace_id=? AND group_id<>? AND rowid BETWEEN (SELECT MIN(rowid) FROM operations WHERE workspace_id=? AND group_id=?) AND (SELECT MAX(rowid) FROM operations WHERE workspace_id=? AND group_id=?) LIMIT 1').get(workspaceId,entry.group_id,workspaceId,entry.group_id,workspaceId,entry.group_id);
        if (interleaved) throw new Fault(409, '这条旧历史包含交错编辑，无法安全撤销或重做；请在发布变更中逐项检查并丢弃需要恢复的内容');
        const from = direction === 'undo' ? entry.after_tree : entry.before_tree;
        const to = direction === 'undo' ? entry.before_tree : entry.after_tree;
        const merged = mergeTrees(this.store.tree(from),current,this.store.tree(to));
        if(merged.conflicts.length) throw new Fault(409,'后续修改与撤销或重做冲突',merged.conflicts);
        return { entry, tree: merged.tree };
    }
    mark(entry: Entry, direction: 'undo'|'redo') {
        const clock = (this.store.db.prepare('SELECT COALESCE(MAX(changed),0)+1 AS value FROM history_entries').get() as any).value;
        this.store.db.prepare('UPDATE history_entries SET state=?,changed=? WHERE workspace_id=? AND group_id=?').run(direction === 'undo' ? 'undone' : 'applied',clock,entry.workspace_id,entry.group_id);
    }
}
