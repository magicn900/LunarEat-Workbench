import { t } from './i18n';
import { ChevronRight, Folder, FileText } from 'lucide-react';
import { EntityMenuButton } from './CommandSurface';
import { locked } from './editing';
import { navigate, notify, put } from './state';
import type { Entity } from '../shared/model';
type Branch = {
    children: Record<string, Branch>;
    files: Entity[];
};
export function createFolder() { if(locked()){notify(t("请先收回控制权"),true);return;} const path = prompt(t("新目录路径，例如：设计/战斗")); if (!path?.trim())
    return; const id = crypto.randomUUID(); void put({ id, kind: 'folder', title: path.split('/').at(-1)!, path: path + '/__directory.json' }, null).catch(error => notify(error.message, true)); }
export function DirectoryTree({ entities, selected }: {
    entities: Entity[];
    selected: string;
}) {
    const root: Branch = { children: Object.create(null), files: [] };
    for (const entity of entities) {
        const parts = entity.path.split('/');
        parts.pop();
        let branch = root;
        for (const name of parts)
            branch = branch.children[name] ??= { children: Object.create(null), files: [] };
        if (entity.kind === 'object')
            branch.files.push(entity);
    }

    const render = (branch: Branch, prefix = '') => <>{Object.entries(branch.children).sort(([left], [right]) => left.localeCompare(right, 'zh-CN')).map(([name, child]) => { const path = prefix ? prefix + '/' + name : name; return <details open className="directory" key={path}><summary className="nav-tree-row" data-directory-path={path}><ChevronRight className="directory-chevron" size={13}/><Folder size={16}/><span>{name}</span><EntityMenuButton directory={path} title={name}/></summary><div>{render(child, path)}</div></details>; })}{branch.files.map(entity => <div className="file-entry nav-tree-row nav-tree-leaf" key={entity.id} data-entity-id={entity.id}><button className={'nav-item' + (selected === entity.id ? ' current' : '')} aria-current={selected === entity.id ? 'page' : undefined} onClick={() => navigate(entity.id)} title={entity.path}><FileText size={16}/><span>{entity.title}</span></button><EntityMenuButton id={entity.id} title={entity.title}/></div>)}</>;
    return render(root);
}
