import type { Store } from './store.js';
import { Fault } from './fault.js';

export function projectState(store: Store, projectId: string) {
    const project = store.db.prepare('SELECT p.id,p.name,COALESCE(s.archived,0) AS archived,COALESCE(s.deleted,0) AS deleted,COALESCE(s.version,0) AS version FROM projects p LEFT JOIN project_lifecycle s ON s.project_id=p.id WHERE p.id=?').get(projectId) as { id: string; name: string; archived: number; deleted: number; version: number } | undefined;
    if (!project || project.deleted) throw new Fault(404, '项目不存在或已删除');
    return project;
}
export function writableProject(store: Store, projectId: string) {
    if (projectState(store, projectId).archived) throw new Fault(409, '项目已归档，只能查看；请联系管理员恢复项目');
}
export function visibleProjects(store: Store) {
    return store.db.prepare('SELECT p.id,p.name,COALESCE(s.archived,0) AS archived,COALESCE(s.version,0) AS version FROM projects p LEFT JOIN project_lifecycle s ON s.project_id=p.id WHERE COALESCE(s.deleted,0)=0 ORDER BY p.name,p.id').all();
}
export function effectiveProjectScopes(store: Store, projectId: string, scopes: string[]) {
    return projectState(store, projectId).archived ? scopes.filter(scope => scope.endsWith('.read')) : scopes;
}
export function initializeProject(store: Store, id: string, name: string) {
    if (store.db.prepare('SELECT id FROM projects WHERE id=?').get(id)) throw new Fault(409, '项目标识已存在');
    const tree = store.putTree({}), revision = store.commit(id, {}, '', '初始化策划项目 ' + id);
    store.git(id, ['update-ref', 'refs/heads/main', revision]);
    store.db.prepare('INSERT INTO projects VALUES (?,?)').run(id, name);
    store.db.prepare('INSERT INTO revisions VALUES (?,?,?,?,?)').run(revision, id, tree, null, new Date().toISOString());
    return { id, name };
}
