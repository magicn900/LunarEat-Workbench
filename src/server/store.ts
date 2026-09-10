import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import { BoundedCache } from './cache.js';
import { createGitCommit, createGitCommitAsync } from './gitCommit.js';
import { serialize, deserialize, type Entity, type Tree } from '../shared/model.js';
export class Store {
    readonly db: Database.Database;
    readonly root: string;
    private readonly notifications = new EventEmitter().setMaxListeners(0);
    private readonly pendingNotifications = new Set<string>();
    private readonly objects = new BoundedCache<Entity>(64 * 1024 * 1024);
    private readonly manifests = new BoundedCache<Record<string, string>>(8 * 1024 * 1024, 128);
    constructor(root: string) {
        this.root = resolve(root);
        mkdirSync(join(this.root, 'objects'), { recursive: true });
        this.db = new Database(join(this.root, 'state.sqlite'));
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this.db.exec('CREATE TABLE IF NOT EXISTS image_assets(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,user_id TEXT NOT NULL,hash TEXT NOT NULL,mime TEXT NOT NULL,extension TEXT NOT NULL,name TEXT NOT NULL,size INTEGER NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,published INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS image_assets_owner_hash ON image_assets(project_id,user_id,hash);');
        this.db.pragma('synchronous = FULL');
        this.db.exec([
            'CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,password TEXT NOT NULL);',
            'CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL);',
            'CREATE TABLE IF NOT EXISTS members(user_id TEXT NOT NULL,project_id TEXT NOT NULL,can_sync INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(user_id,project_id));',
            'CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires INTEGER NOT NULL);',
            'CREATE TABLE IF NOT EXISTS tokens(id TEXT PRIMARY KEY,hash TEXT UNIQUE NOT NULL,user_id TEXT NOT NULL,project_id TEXT NOT NULL,name TEXT NOT NULL,scopes TEXT NOT NULL,created TEXT NOT NULL);',
            'CREATE TABLE IF NOT EXISTS trees(id TEXT PRIMARY KEY,manifest TEXT NOT NULL);',
            'CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,project_id TEXT NOT NULL,base TEXT NOT NULL,head TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,UNIQUE(user_id,project_id));',
            'CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,tree TEXT NOT NULL,parent TEXT,created TEXT NOT NULL);',
            'CREATE TABLE IF NOT EXISTS publications(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,workspace_id TEXT NOT NULL,old_main TEXT NOT NULL,revision TEXT NOT NULL,tree TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL,actor TEXT NOT NULL,state TEXT NOT NULL,created TEXT NOT NULL);',
            'CREATE TABLE IF NOT EXISTS confirmations(id TEXT PRIMARY KEY,publication_id TEXT NOT NULL,repository TEXT NOT NULL,commit_id TEXT NOT NULL,note TEXT NOT NULL,actor TEXT NOT NULL,active INTEGER NOT NULL,created TEXT NOT NULL);',
            'CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,actor TEXT NOT NULL,group_id TEXT NOT NULL,before_tree TEXT NOT NULL,after_tree TEXT NOT NULL,created TEXT NOT NULL);',
            'CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,workspace_id TEXT,project_id TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL);',
            'CREATE TABLE IF NOT EXISTS requests(key TEXT PRIMARY KEY,result TEXT NOT NULL);',
            'CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,tags TEXT NOT NULL,author TEXT NOT NULL,editor TEXT NOT NULL,version INTEGER NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);',
            'CREATE TABLE IF NOT EXISTS documents(workspace_id TEXT NOT NULL,entity_id TEXT NOT NULL,version INTEGER NOT NULL,body TEXT NOT NULL,doc TEXT NOT NULL,PRIMARY KEY(workspace_id,entity_id));',
            'CREATE TABLE IF NOT EXISTS steps(workspace_id TEXT NOT NULL,entity_id TEXT NOT NULL,version INTEGER NOT NULL,steps TEXT NOT NULL,client_id TEXT NOT NULL,PRIMARY KEY(workspace_id,entity_id,version));'
        ].join('\n'));
        const documentColumns = this.db.prepare('PRAGMA table_info(documents)').all() as { name: string }[];
        if (!documentColumns.some(column => column.name === 'schema_version')) this.db.exec('ALTER TABLE documents ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 2');
        this.db.exec([
            'CREATE TABLE IF NOT EXISTS project_lifecycle(project_id TEXT PRIMARY KEY REFERENCES projects(id),archived INTEGER NOT NULL DEFAULT 0,deleted INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 0);',
            'CREATE TABLE IF NOT EXISTS deleted_accounts(user_id TEXT PRIMARY KEY REFERENCES users(id),created TEXT NOT NULL);',
            'CREATE TABLE IF NOT EXISTS account_preferences(user_id TEXT PRIMARY KEY REFERENCES users(id),theme TEXT NOT NULL,language TEXT NOT NULL,version INTEGER NOT NULL);',
            'CREATE TABLE IF NOT EXISTS account_access(user_id TEXT PRIMARY KEY REFERENCES users(id),administrator INTEGER NOT NULL DEFAULT 0,disabled INTEGER NOT NULL DEFAULT 0);',
            'CREATE TABLE IF NOT EXISTS member_permissions(user_id TEXT NOT NULL,project_id TEXT NOT NULL,scopes TEXT NOT NULL,PRIMARY KEY(user_id,project_id),FOREIGN KEY(user_id,project_id) REFERENCES members(user_id,project_id));',
            'CREATE TABLE IF NOT EXISTS admin_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,details TEXT NOT NULL,created TEXT NOT NULL);'
        ].join('\n'));
        const preferenceColumns = this.db.prepare('PRAGMA table_info(account_preferences)').all() as { name: string }[];
        if (!preferenceColumns.some(column => column.name === 'shortcuts')) this.db.exec("ALTER TABLE account_preferences ADD COLUMN shortcuts TEXT NOT NULL DEFAULT '{}'");
        this.db.exec('CREATE INDEX IF NOT EXISTS events_project_sequence ON events(project_id,seq); CREATE INDEX IF NOT EXISTS operations_workspace_group ON operations(workspace_id,group_id); CREATE INDEX IF NOT EXISTS publications_project ON publications(project_id,state); CREATE INDEX IF NOT EXISTS confirmations_publication ON confirmations(publication_id);');
    }
    hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
    putTree(tree: Tree, base?: string): string {
        const previous = base ? this.manifest(base) : {};
        const manifest: Record<string, string> = {};
        for (const [id, entity] of Object.entries(tree).sort(([left], [right]) => left.localeCompare(right))) {
            const existing = previous[id];
            if (existing && isDeepStrictEqual(entity, this.object(existing))) { manifest[id] = existing; continue; }
            manifest[id] = this.putObject(entity);
        }
        const json = JSON.stringify(manifest), id = this.hash(json);
        this.db.prepare('INSERT OR IGNORE INTO trees(id,manifest) VALUES (?,?)').run(id, json);
        return id;
    }
    private putObject(entity: Entity): string {
        const text = serialize(entity), hash = this.hash(text), destination = join(this.root, 'objects', hash);
        if (!existsSync(destination)) {
            const temporary = destination + '.' + randomUUID();
            writeFileSync(temporary, text, 'utf8');
            const descriptor = openSync(temporary, 'r+');
            try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
            renameSync(temporary, destination);
        }
        return hash;
    }
    updateObjects(base: string, changes: Tree): string {
        const manifest = { ...this.manifest(base) };
        for (const [id, entity] of Object.entries(changes)) {
            if (!manifest[id] || entity.id !== id || entity.kind !== 'object') throw new Error('局部更新仅支持现有对象');
            const original = this.object(manifest[id]);
            if (original.kind !== 'object' || entity.path !== original.path || entity.collection !== original.collection || entity.title !== original.title) throw new Error('局部更新不能修改对象结构');
            if (!isDeepStrictEqual(entity, original)) manifest[id] = this.putObject(entity);
        }
        const json = JSON.stringify(manifest), id = this.hash(json);
        this.db.prepare('INSERT OR IGNORE INTO trees(id,manifest) VALUES (?,?)').run(id, json);
        return id;
    }
    view(id: string): Tree {
        const manifest = this.manifest(id);
        return new Proxy({} as Tree, {
            get: (target, key) => {
                if (typeof key !== 'string' || !Object.hasOwn(manifest, key)) return undefined;
                return target[key] ??= structuredClone(this.object(manifest[key]));
            },
            ownKeys: () => Object.keys(manifest),
            getOwnPropertyDescriptor: (_target, key) => typeof key === 'string' && Object.hasOwn(manifest, key) ? { enumerable: true, configurable: true } : undefined
        });
    }
    manifest(id: string): Readonly<Record<string, string>> {
        const cached = this.manifests.get(id);
        if (cached && this.db.prepare('SELECT 1 FROM trees WHERE id=?').get(id)) return cached;
        const row = this.db.prepare('SELECT manifest FROM trees WHERE id=?').get(id) as { manifest: string } | undefined;
        if (!row) throw new Error('内容树不存在');
        const manifest = Object.freeze(JSON.parse(row.manifest));
        this.manifests.set(id, manifest, row.manifest.length * 4 + 1024);
        return manifest;
    }
    private object(hash: string): Entity {
        const cached = this.objects.get(hash);
        if (cached) return cached;
        const text = readFileSync(join(this.root, 'objects', hash), 'utf8');
        const entity = deserialize(text);
        this.objects.set(hash, entity, text.length * 4 + 1024);
        return entity;
    }
    entity(treeId: string, id: string): Entity | undefined {
        const hash = this.manifest(treeId)[id];
        return hash ? structuredClone(this.object(hash)) : undefined;
    }
    tree(id: string): Tree {
        return Object.fromEntries(Object.entries(this.manifest(id)).map(([key, hash]) => [key, structuredClone(this.object(hash))]));
    }
    changed(before: string, after: string): string[] {
        if (before === after) return [];
        const previous = this.manifest(before), current = this.manifest(after);
        return [...new Set([...Object.keys(previous), ...Object.keys(current)])].filter(id => previous[id] !== current[id]);
    }
    comparison(before: string, after: string) {
        const previous: Tree = {}, current: Tree = {};
        const ids = new Set(this.changed(before, after));
        for (const id of ids) {
            const first = this.entity(before, id), last = this.entity(after, id);
            if (first) previous[id] = first;
            if (last) current[id] = last;
            for (const entity of [first, last]) if (entity?.kind === 'object' && entity.collection) ids.add(entity.collection);
        }
        return { before: previous, after: current };
    }
    git(project: string, args: string[], input?: string): string {
        if (!/^[a-zA-Z0-9_-]+$/.test(project))
            throw new Error('项目标识不合法');
        const directory = join(this.root, 'git', project + '.git');
        if (!existsSync(directory)) {
            mkdirSync(directory, { recursive: true });
            execFileSync('git', ['init', '--bare', directory], { stdio: 'pipe' });
        }
        return execFileSync('git', ['--git-dir=' + directory, ...args], { input, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: '工作台', GIT_AUTHOR_EMAIL: 'workbench@localhost', GIT_COMMITTER_NAME: '工作台', GIT_COMMITTER_EMAIL: 'workbench@localhost' }, maxBuffer: 20 * 1024 * 1024 }).trim();
    }
    main(project: string): string {
        if (!/^[a-zA-Z0-9_-]+$/.test(project)) throw new Error('项目标识不合法');
        const directory = join(this.root, 'git', project + '.git');
        try { return readFileSync(join(directory, 'refs', 'heads', 'main'), 'utf8').trim(); }
        catch (error: any) { if (error.code !== 'ENOENT') throw error; }
        try { return readFileSync(join(directory, 'packed-refs'), 'utf8').split('\n').find(line => line.endsWith(' refs/heads/main'))?.split(' ')[0] || ''; }
        catch (error: any) { if (error.code !== 'ENOENT') throw error; return ''; }
    }
    commit(project: string, tree: Tree, parent: string, title: string): string {
        this.git(project, ['rev-parse', '--git-dir']);
        return createGitCommit(join(this.root, 'git', project + '.git'), tree, parent, title);
    }
    commitAsync(project: string, tree: Tree, parent: string, title: string): Promise<string> {
        if (!/^[a-zA-Z0-9_-]+$/.test(project)) throw new Error('项目标识不合法');
        return createGitCommitAsync(join(this.root, 'git', project + '.git'), tree, parent, title);
    }
    subscribe(project: string, listener: () => void) {
        this.notifications.on(project, listener);
        return () => { this.notifications.off(project, listener); };
    }
    emit(project: string, workspace: string | null, kind: string, payload: unknown) {
        const sequence = Number(this.db.prepare('INSERT INTO events(project_id,workspace_id,kind,payload) VALUES (?,?,?,?)').run(project, workspace, kind, JSON.stringify(payload)).lastInsertRowid);
        if (!this.pendingNotifications.has(project)) {
            this.pendingNotifications.add(project);
            queueMicrotask(() => { this.pendingNotifications.delete(project); this.notifications.emit(project); });
        }
        return sequence;
    }
    close() { this.notifications.removeAllListeners(); this.objects.clear(); this.manifests.clear(); this.db.close(); }
}
