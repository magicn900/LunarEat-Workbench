import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Store } from './store.js';
import type { Actor } from '../shared/model.js';
import { Fault } from './fault.js';
export { Fault } from './fault.js';
import { effectiveProjectScopes, projectState } from './projectState.js';
import { defaultPreferences, type Preferences } from '../shared/preferences.js';
export function accountPreferences(store: Store, userId: string): Preferences {
    return (store.db.prepare('SELECT theme,language,version FROM account_preferences WHERE user_id=?').get(userId) as Preferences | undefined) || { ...defaultPreferences };
}
import { capabilities } from '../shared/permissions.js';
export { capabilities } from '../shared/permissions.js';
export function accountAccess(store: Store, userId: string) {
    if (store.db.prepare('SELECT user_id FROM deleted_accounts WHERE user_id=?').get(userId)) throw new Fault(401, '账号已删除');
    const access = store.db.prepare('SELECT * FROM account_access WHERE user_id=?').get(userId) as any;
    if (access?.disabled) throw new Fault(401, '账号已停用，请联系管理员');
    return { administrator: !!access?.administrator };
}
export function memberScopes(store: Store, member: any): string[] {
    const permissions = store.db.prepare('SELECT scopes FROM member_permissions WHERE user_id=? AND project_id=?').get(member.user_id, member.project_id) as any;
    return permissions ? JSON.parse(permissions.scopes) : capabilities.filter(scope => scope !== 'design.sync' || member.can_sync);
}

export function passwordHash(password: string) { if (password.length < 10)
    throw new Fault(400, '密码至少 10 个字符'); const salt = randomBytes(16).toString('hex'); return salt + ':' + scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex'); }
export function checkPassword(password: string, hash: string) { const [salt, key] = hash.split(':'); const actual = scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }); return timingSafeEqual(actual, Buffer.from(key, 'hex')); }
export function createUser(store: Store, username: string, password: string, projectId: string, canSync = false) { if (!store.db.prepare('SELECT id FROM projects WHERE id=?').get(projectId))
    throw new Fault(404, '项目不存在'); projectState(store, projectId); const id = randomUUID(); store.db.prepare('INSERT INTO users VALUES (?,?,?)').run(id, username, passwordHash(password)); store.db.prepare('INSERT INTO members VALUES (?,?,?)').run(id, projectId, canSync ? 1 : 0); return id; }
export function actorFor(store: Store, credential: string, agent = false, projectId?: string): Actor {
    const row = agent ? store.db.prepare('SELECT t.*,u.username FROM tokens t JOIN users u ON u.id=t.user_id WHERE t.hash=?').get(store.hash(credential)) as any : store.db.prepare('SELECT s.*,u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires>?').get(store.hash(credential), Date.now()) as any;
    if (!row)
        throw new Fault(401, '请登录或检查 Agent 凭据');
    const access = accountAccess(store, row.user_id);
    const project = agent ? row.project_id : projectId;
    const member = project ? store.db.prepare('SELECT * FROM members WHERE user_id=? AND project_id=?').get(row.user_id, project) as any : store.db.prepare('SELECT m.* FROM members m WHERE user_id=? AND NOT EXISTS (SELECT 1 FROM project_lifecycle s WHERE s.project_id=m.project_id AND s.deleted=1) ORDER BY project_id LIMIT 1').get(row.user_id) as any;
    if (!member)
        throw new Fault(403, '没有项目访问权限');
    const allowed = effectiveProjectScopes(store, member.project_id, memberScopes(store, member));
    return { userId: row.user_id, username: row.username, projectId: member.project_id, kind: agent ? 'agent' : 'human', sessionId: agent ? row.id : row.hash, scopes: agent ? JSON.parse(row.scopes).filter((scope: string) => allowed.includes(scope)) : allowed, canSync: allowed.includes('design.sync'), administrator: access.administrator };
}
export function requireScope(actor: Actor, scope: string) { if (!actor.scopes.includes(scope) || (scope === 'design.sync' && !actor.canSync))
    throw new Fault(403, '缺少权限: ' + scope); }
export function issueToken(store: Store, actor: Actor, name: string, scopes: string[]) { if (actor.kind !== 'human')
    throw new Fault(403, 'Agent 不能创建凭据'); if (scopes.some(scope => !actor.scopes.includes(scope)))
    throw new Fault(403, '不能授予自身没有的权限'); const token = randomBytes(32).toString('base64url'), id = randomUUID(); store.db.prepare('INSERT INTO tokens VALUES (?,?,?,?,?,?,?)').run(id, store.hash(token), actor.userId, actor.projectId, name, JSON.stringify(scopes), new Date().toISOString()); return { id, token }; }
