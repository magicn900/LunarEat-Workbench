import { useState } from 'react';
import { t } from './i18n';
import { permissionDependencies, permissionLabels } from '../shared/permissions';
import type { Account, Member, AdminData } from './adminTypes';
const label = (scope: string) => t(permissionLabels[scope as keyof typeof permissionLabels] || scope);

export function MemberEditor({ user, project, member, save, busy, heading }: { user: Account; project: AdminData['projects'][number]; member?: Member; save: (body: unknown) => Promise<boolean>; busy: boolean; heading?: string }) {
    const [scopes, setScopes] = useState(member?.scopes || []);
    const toggle = (scope: string, checked: boolean) => setScopes(previous => checked ? [...new Set([...previous, scope, ...(permissionDependencies[scope] || [])])] : previous.filter(item => item !== scope && !(permissionDependencies[item] || []).includes(scope)));
    const changed = JSON.stringify([...scopes].sort()) !== JSON.stringify([...(member?.scopes || [])].sort());
    return <form className="admin-membership" onSubmit={event => { event.preventDefault(); void save({ userId: user.id, projectId: project.id, scopes, expectedScopes: member?.scopes || null }); }}>
        <header><h3>{heading || project.name}</h3><span className="admin-badge">{member ? t("项目成员") : t("尚未加入")}</span></header>
        <fieldset disabled={busy}><legend>{t("允许此成员做什么")}</legend><div className="admin-permissions">{Object.keys(permissionLabels).map(scope => <label key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={event => toggle(scope, event.target.checked)}/><span>{label(scope)}</span></label>)}</div></fieldset>
        {changed && <p className="admin-preview">{t("新增：")}{scopes.filter(scope => !member?.scopes.includes(scope)).map(label).join('、') || t("无")}<br/>{t("收回：")}{(member?.scopes || []).filter(scope => !scopes.includes(scope)).map(label).join('、') || t("无")}</p>}
        <footer><small>{t("收回权限对下次请求生效；Agent 已失去的授权不会自动恢复。")}</small><button className="primary" disabled={busy || (!!member && !changed)}>{member ? t("保存项目权限") : t("加入此项目")}</button></footer>
    </form>;
}
