import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store';
it('旧数据库升级保留正文和偏好，重复启动不重复迁移', () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-migration-'));
    let store: Store | undefined;
    const old = new Database(join(directory, 'state.sqlite'));
    try {
        old.exec("CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,password TEXT NOT NULL); INSERT INTO users VALUES('user','designer','hash'); CREATE TABLE account_preferences(user_id TEXT PRIMARY KEY REFERENCES users(id),theme TEXT NOT NULL,language TEXT NOT NULL,version INTEGER NOT NULL); INSERT INTO account_preferences VALUES('user','dark','zh-CN',7); CREATE TABLE documents(workspace_id TEXT NOT NULL,entity_id TEXT NOT NULL,version INTEGER NOT NULL,body TEXT NOT NULL,doc TEXT NOT NULL,PRIMARY KEY(workspace_id,entity_id)); INSERT INTO documents VALUES('workspace','page',8,'原有正文','{}');");
        old.close();
        for (const attempt of [1, 2]) {
            store = new Store(directory);
            expect(store.db.prepare('SELECT * FROM documents').get()).toEqual({ workspace_id: 'workspace', entity_id: 'page', version: 8, body: '原有正文', doc: '{}', schema_version: 2 });
            expect(store.db.prepare('SELECT * FROM account_preferences').get()).toEqual({ user_id: 'user', theme: 'dark', language: 'zh-CN', version: 7, shortcuts: attempt === 1 ? '{}' : '{"highlight":"Mod+Alt+H"}' });
            store.db.prepare('UPDATE account_preferences SET shortcuts=?').run('{"highlight":"Mod+Alt+H"}');
            store.close(); store = undefined;
        }
    } finally {
        if (old.open) old.close();
        store?.close();
        if (directory.startsWith(join(tmpdir(), 'workbench-migration-'))) rmSync(directory, { recursive: true, force: true });
    }
});
