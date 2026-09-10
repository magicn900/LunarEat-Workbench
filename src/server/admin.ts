import { initializeProject } from './projectState.js';
import { Store } from './store.js';
import { randomUUID } from 'node:crypto';
import { seed } from './seed.js';
import { createUser, passwordHash, memberScopes } from './auth.js';
import { audit, updateAccountAccess } from './administration.js';
import { mkdirSync, cpSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { acquireRuntimeLock } from './runtime.js';
const directory = process.env.WORKBENCH_DATA || '.local-data/demo';
const release = acquireRuntimeLock(directory);
const store = new Store(directory);
try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'seed')
        console.log(JSON.stringify(seed(store), null, 2));
    else if (command === 'init') {
        const [project, name] = args;
        if (!project || !name || !/^[a-zA-Z0-9_-]+$/.test(project))
            throw new Error('用法: admin init 项目ID 项目名称');
        store.db.transaction(() => { initializeProject(store, project, name); audit(store, '本机管理员', '创建项目', project, { name }); })();
        console.log('项目已创建；使用 create-user 创建成员');
    }
    else if (command === 'create-user') {
        const [username, project = 'demo', permission] = args;
        if (!username || !process.env.WORKBENCH_PASSWORD)
            throw new Error('用法: WORKBENCH_PASSWORD 环境变量 + admin create-user 用户名 项目ID [sync]');
        console.log(store.db.transaction(() => { const id = createUser(store, username, process.env.WORKBENCH_PASSWORD!, project, permission === 'sync'); audit(store, '本机管理员', '创建账号并加入项目', id, { username, projectId: project }); return id; })());
    }
    else if (command === 'reset-password') {
        if (!process.env.WORKBENCH_PASSWORD)
            throw new Error('缺少 WORKBENCH_PASSWORD');
        store.db.transaction(() => { const user = store.db.prepare('SELECT id FROM users WHERE username=?').get(args[0]) as any; if (!user)
            throw new Error('用户不存在'); store.db.prepare('UPDATE users SET password=? WHERE id=?').run(passwordHash(process.env.WORKBENCH_PASSWORD!), user.id); store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id); store.db.prepare('DELETE FROM tokens WHERE user_id=?').run(user.id); audit(store, '本机管理员', '重置密码并撤销凭据', user.id, {}); })();
        console.log('密码已更新，会话与 Agent 凭据已撤销');
    }
    else if (command === 'create-admin') {
        if (!args[0] || !process.env.WORKBENCH_PASSWORD) throw new Error('用法: WORKBENCH_PASSWORD 环境变量 + admin create-admin 用户名');
        store.db.transaction(() => {
            if (store.db.prepare('SELECT id FROM users WHERE username=?').get(args[0])) throw new Error('账号已存在；请使用 grant-admin 显式授权');
            const id = randomUUID();
            store.db.prepare('INSERT INTO users VALUES (?,?,?)').run(id, args[0], passwordHash(process.env.WORKBENCH_PASSWORD!));
            audit(store, '本机管理员', '创建账号', id, { username: args[0] });
            updateAccountAccess(store, '本机管理员', id, true, false);
        })();
        console.log('独立平台管理员已创建，不附带项目权限');
    }
    else if (command === 'grant-admin') {
        const user = store.db.prepare('SELECT id FROM users WHERE username=?').get(args[0]) as any;
        if (!user) throw new Error('账号不存在');
        store.db.transaction(() => updateAccountAccess(store, '本机管理员', user.id, args[1] !== 'false', false))();
        console.log('平台管理权限已更新');
    }
    else if (command === 'grant-sync') {
        store.db.transaction(() => {
            const member = store.db.prepare('SELECT m.* FROM members m JOIN users u ON u.id=m.user_id WHERE u.username=? AND m.project_id=?').get(args[0], args[1] || 'demo') as any;
            if (!member) throw new Error('项目成员不存在');
            const enabled = args[2] !== 'false', before = memberScopes(store, member);
            const scopes = enabled ? [...new Set([...before, 'workspace.read', 'design.sync'])] : before.filter(scope => scope !== 'design.sync');
            store.db.prepare('UPDATE members SET can_sync=? WHERE user_id=? AND project_id=?').run(Number(enabled), member.user_id, member.project_id);
            store.db.prepare('INSERT INTO member_permissions VALUES (?,?,?) ON CONFLICT(user_id,project_id) DO UPDATE SET scopes=excluded.scopes').run(member.user_id, member.project_id, JSON.stringify(scopes));
            if (!enabled) for (const token of store.db.prepare('SELECT id,scopes FROM tokens WHERE user_id=? AND project_id=?').all(member.user_id, member.project_id) as any[]) store.db.prepare('UPDATE tokens SET scopes=? WHERE id=?').run(JSON.stringify(JSON.parse(token.scopes).filter((scope: string) => scope !== 'design.sync')), token.id);
            audit(store, '本机管理员', '调整同步权限', member.user_id, { projectId: member.project_id, before, after: scopes });
        })();
        console.log('权限已更新');
    }
    else if (command === 'backup') {
        const destination = resolve(args[0] || '');
        if (!args[0] || existsSync(destination) || destination.startsWith(store.root))
            throw new Error('备份目标必须是数据目录之外的新目录；请先停止服务');
        mkdirSync(destination, { recursive: true });
        await store.db.backup(join(destination, 'state.sqlite'));
        cpSync(join(store.root, 'objects'), join(destination, 'objects'), { recursive: true });
        cpSync(join(store.root, 'git'), join(destination, 'git'), { recursive: true });
        if (existsSync(join(store.root, 'attachments'))) cpSync(join(store.root, 'attachments'), join(destination, 'attachments'), { recursive: true });
        console.log('备份完成: ' + destination);
    }
    else
        throw new Error('命令: seed | init | create-user | create-admin | grant-admin | reset-password | grant-sync | backup');
}
finally {
    store.close();
    release();
}
