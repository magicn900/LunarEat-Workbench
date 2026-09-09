import { randomBytes } from 'node:crypto';
import { Store } from './store.js';
import { createUser } from './auth.js';
import type { Tree } from '../shared/model.js';
export function seed(store: Store, password?: string) {
    return store.db.transaction(() => {
        if (store.db.prepare('SELECT id FROM projects LIMIT 1').get())
            throw new Error('数据目录已有项目，示例初始化不会覆盖现有数据');
        const project = 'demo';
        store.db.prepare('INSERT INTO projects VALUES (?,?)').run(project, '微光战记 · 示例');
        const designerPassword = password || randomBytes(15).toString('base64url'), developerPassword = password || randomBytes(15).toString('base64url');
        const designer = createUser(store, 'designer', designerPassword, project), developer = createUser(store, 'developer', developerPassword, project, true);
        const tree: Tree = {
            overview: { id: 'overview', kind: 'object', path: '设计/战斗概览.md', title: '战斗概览', collection: null, fields: {}, body: '# 战斗概览\n\n每一次选择，都值得被认真设计。\n\n这是一个独立的虚构示例，不连接任何游戏项目。角色每回合获得 3 点能量，选择技能建立自己的战斗节奏。\n\n## 技能速览\n\n:::view[skills-table]\n\n## 设计原则\n\n- 技能消耗应当对应明确的收益。\n- 规则先以文字表达，再同步到实现。\n\n阅读 [技能说明](doc:guide) 了解更多。' },
            guide: { id: 'guide', kind: 'object', path: '设计/技能说明.md', title: '技能说明', collection: null, fields: {}, body: '# 技能说明\n\n返回 [战斗概览](doc:overview)。\n\n下面的视图与概览共享同一组记录，可以直接编辑。\n\n:::view[skills-table]' },
            skills: { id: 'skills', kind: 'collection', path: '集合/技能.json', title: '技能', fields: [{ key: 'cost', label: '消耗', type: 'number', required: true }, { key: 'description', label: '说明', type: 'text', required: false }] },
            'skills-table': { id: 'skills-table', kind: 'view', path: '视图/技能表格.json', title: '技能速览', collection: 'skills', layout: 'table', columns: ['title', 'cost', 'description'], filter: null, sort: null },
            'skills-list': { id: 'skills-list', kind: 'view', path: '视图/技能列表.json', title: '技能列表', collection: 'skills', layout: 'list', columns: ['title', 'cost', 'description'], filter: null, sort: null },
            'skills-cards': { id: 'skills-cards', kind: 'view', path: '视图/技能卡片.json', title: '技能卡片', collection: 'skills', layout: 'cards', columns: ['title', 'cost', 'description'], filter: null, sort: null }
        };
        for (const [id, title, cost, description] of [['frost', '霜刃', 2, '造成伤害并施加寒冷'], ['guard', '守势', 1, '获得护盾'], ['spark', '火花', 1, '造成轻量伤害']] as const)
            tree[id] = { id, kind: 'object', path: '技能/' + id + '.md', title, collection: 'skills', fields: { cost, description }, body: '# ' + title + '\n\n这是一条用户定义的技能记录。' };
        const head = store.putTree(tree), revision = store.commit(project, tree, '', '初始化独立验证示例');
        store.git(project, ['update-ref', 'refs/heads/main', revision]);
        store.db.prepare('INSERT INTO revisions VALUES (?,?,?,?,?)').run(revision, project, head, null, new Date().toISOString());
        for (const user of [designer, developer])
            store.db.prepare('INSERT INTO workspaces VALUES (?,?,?,?,?,0)').run(user + '-workspace', user, project, revision, head);
        const now = new Date().toISOString();
        for (const [id, title, body] of [['idea-1', '让天气参与战斗', '如果雨天能够改变技能效果，会出现怎样的选择？'], ['idea-2', '一次尚未成形的联想', '隔离验证词：琥珀纸鹤。这里的内容不是正式设计依据。']])
            store.db.prepare('INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, project, title, body, JSON.stringify(['待探索']), 'designer', 'designer', 1, now, now);
        return { project, designer: { username: 'designer', password: designerPassword }, developer: { username: 'developer', password: developerPassword } };
    })();
}
