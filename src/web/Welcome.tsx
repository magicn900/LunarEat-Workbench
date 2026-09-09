import { WorkspaceIdentity } from './WorkspaceIdentity';
import { useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, FolderOpen, Lightbulb, RefreshCw, ShieldCheck } from 'lucide-react';
import { AccountBar } from './Account';
import { useAccount } from './accountContext';
import { t } from './i18n';
import './welcome.css';

export function Welcome({ refresh, children }: { refresh: () => Promise<boolean>; children: ReactNode }) {
    const { identity, projectId } = useAccount();
    const project = identity.projects.find(project => project.id === projectId);
    const [inspiration, setInspiration] = useState(false), [refreshing, setRefreshing] = useState(false), [refreshed, setRefreshed] = useState(false);
    const canReadInspiration = !!project?.scopes.includes('inspiration.read');
    const showInspiration = inspiration && canReadInspiration;
    const refreshAccess = async () => {
        if (refreshing) return;
        setRefreshing(true); setRefreshed(false);
        try { setRefreshed(await refresh()); }
        finally { setRefreshing(false); }
    };
    const heading = identity.administrator ? t('管理平台，或加入项目开始策划') : project ? t('你已加入项目') : t('还没有可访问的项目');
    const description = identity.administrator ? t('管理权限与项目成员权限相互独立。你可以先管理账号与成员，加入项目后再开始策划。') : project ? t('当前账号没有此项目的设计查看权限。你仍可以使用已获授权的功能。') : t('请联系平台管理员，将你的账号添加为项目成员。授权后，可刷新访问权限继续。');
    const Icon = identity.administrator ? ShieldCheck : FolderOpen;
    return <div className="welcome-shell">
        <header className="welcome-header"><WorkspaceIdentity projectName={project?.name}/><div className="welcome-account"><AccountBar/></div></header>
        <main className={'welcome-main' + (showInspiration ? ' is-inspiration' : '')}>
            {showInspiration ? <><button className="welcome-back" onClick={() => setInspiration(false)}><ArrowLeft size={16}/>{t('返回开始使用')}</button>{children}</> : <section className="welcome-card" aria-labelledby="welcome-title">
                <div className="welcome-symbol" aria-hidden="true"><Icon size={28}/></div>
                <p className="welcome-eyebrow">{t('开始使用')}</p><h1 id="welcome-title">{heading}</h1><p className="welcome-description">{description}</p>
                {project && <div className="welcome-project"><FolderOpen size={18}/><div><span>{t('当前项目')}</span><strong>{project.name}</strong></div></div>}
                {canReadInspiration && <div className="welcome-feature"><Lightbulb size={22}/><div><h2>{t('共享灵感池')}</h2><p>{t('浏览团队的灵感与便签，独立于策划文档和版本。')}</p></div></div>}
                <div className="welcome-actions">
                    {identity.administrator && <a className="primary" href="/admin"><ShieldCheck size={17}/>{t('进入平台管理')}<ArrowRight size={17}/></a>}
                    {canReadInspiration && <button className={identity.administrator ? '' : 'primary'} onClick={() => setInspiration(true)}>{t('打开灵感池')}<ArrowRight size={17}/></button>}
                    <button disabled={refreshing} onClick={() => void refreshAccess()}><RefreshCw size={16}/>{refreshing ? t('正在刷新…') : t('刷新访问权限')}</button>
                </div>
                <p className="welcome-notice" role="status">{refreshed ? t('访问权限已刷新') : t('账号设置与退出登录位于右上角账号菜单。')}</p>
            </section>}
        </main>
    </div>;
}
