import { t } from './i18n';
import { useEffect, useState, lazy, Suspense } from 'react';
const Admin = lazy(() => import('./Admin').then(module => ({ default: module.Admin })));
import './admin.css';
import './management.css';
import { PanelBoundary } from './PanelBoundary';
import { App, Inspiration, Login } from './App';
import { api, clearSnapshot, reload, currentProject, selectProject } from './state';
import { flushEditing } from './editing';

import { AccountProvider } from './Account';
import { Welcome } from './Welcome';
import { type AccountIdentity as Identity } from './accountContext';
import { useLanguage } from './i18n';
export function Portal() {
    const [identity, setIdentity] = useState<Identity | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
    const [projectId, setProjectId] = useState(currentProject());
    const language = useLanguage();
    const administration = location.pathname.replace(/\/$/, '') === '/admin';
    const load = async () => {
        try {
            const next: Identity = await api('/identity');
            const chosen = next.projects.find(project => project.id === currentProject()) || next.projects[0];
            selectProject(chosen?.id || '');
            setProjectId(chosen?.id || '');
            setIdentity(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
            setError('');
            return true;
        } catch (error: any) { if (error.status === 401) { setIdentity(null); clearSnapshot(); } else setError(error.message); return false; }
        finally { setLoading(false); }
    };
    useEffect(() => {
        void load();
        const timer = setInterval(() => void load(), 10000);
        const refresh = () => void load();
        window.addEventListener('focus', refresh);
        window.addEventListener('identity-changed', refresh);
        return () => { clearInterval(timer); window.removeEventListener('focus', refresh); window.removeEventListener('identity-changed', refresh); };
    }, []);
    const project = identity?.projects.find(project => project.id === projectId);
    useEffect(() => { document.title = [administration ? t('平台管理') : project?.name, t('工作台')].filter(Boolean).join(' · '); }, [administration, project?.name, language]);
    useEffect(() => { if (!administration && project?.scopes.includes('workspace.read')) void reload().catch(() => {}); }, [identity, projectId]);
    if (loading) return <div className="portal-message" role="status">{t("正在确认登录状态…")}</div>;
    if (!identity) return error ? <div className="portal-message" role="alert">{t(error)}<button onClick={() => void load()}>{t("重试")}</button></div> : <Login onLogin={load}/>;
    const adminContent = identity.administrator ? <PanelBoundary fallback={<div className="portal-message" role="alert">{t('管理页面加载失败，请刷新后重试。')}</div>}><Suspense fallback={<div className="portal-message">{t('正在加载…')}</div>}><Admin username={identity.username}/></Suspense></PanelBoundary> : <div className="portal-message"><h1>{t("此入口仅对平台管理员开放")}</h1><p>{t("你可以继续使用已授权的项目功能。")}</p><a href="/">{t("返回工作台")}</a><button onClick={() => void api('/logout', {}).then(load).catch(error => setError(error.message))}>{t("切换账号")}</button></div>;
    const scopes = project?.scopes || [];
    const workspace = scopes.includes('workspace.read');
    const switchProject = async (id: string) => { await flushEditing(); selectProject(id); setProjectId(id); };
    return <AccountProvider key={identity.id} identity={identity} projectId={projectId} switchProject={switchProject} refreshIdentity={async () => { await load(); }}>
        {administration ? adminContent : <>{error && <p role="alert" className="admin-feedback">{t(error)}</p>}{!workspace && project?.archived && <p className="project-archive-notice" role="status">{t("项目已归档，当前仅可查看。请联系管理员恢复项目后继续编辑。")}</p>}{workspace ? <App key={identity.id + projectId}/> : <Welcome key={projectId} refresh={load}>{scopes.includes('inspiration.read') && <Inspiration scopes={scopes}/>}</Welcome>}</>}
    </AccountProvider>;
}
