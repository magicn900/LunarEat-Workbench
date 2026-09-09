import { useEffect, useRef, useState, lazy, Suspense, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Check, Ellipsis, Settings, ShieldCheck, LogOut, Folder } from 'lucide-react';
import { AccountContext, useAccount, type AccountIdentity } from './accountContext';
import type { Preferences } from '../shared/preferences';
import { api } from './state';
import { flushEditing } from './editing';
import { applyAppearance } from './appearance';
import { Modal } from './Modal';
import { PanelBoundary } from './PanelBoundary';
const SettingsDialog = lazy(() => import('./SettingsDialog').then(module => ({ default: module.SettingsDialog })));
import { t, useLanguage } from './i18n';
import './account.css';

export function AccountProvider({ identity, projectId, switchProject, refreshIdentity, children }: { identity: AccountIdentity; projectId: string; switchProject: (id: string) => Promise<void>; refreshIdentity: () => Promise<void>; children: ReactNode }) {
    const [preferences, setPreferences] = useState(identity.preferences), [settings, setSettings] = useState(false);
    const saving = useRef(false), trigger = useRef<HTMLElement | null>(null);
    useEffect(() => { setPreferences(previous => identity.preferences.version >= previous.version ? identity.preferences : previous); }, [identity.preferences]);
    useEffect(() => { applyAppearance(preferences); }, [preferences]);
    const savePreferences = async (next: Preferences) => {
        if (saving.current) throw Error(t('设置正在保存，请稍候'));
        saving.current = true;
        try { const saved = await api('/account/preferences', next); setPreferences(saved); applyAppearance(saved); await refreshIdentity(); }
        catch (error) { await refreshIdentity(); throw error; }
        finally { saving.current = false; }
    };
    const signOut = async () => { await flushEditing(); await api('/logout', {}); await refreshIdentity(); };
    const close = () => { setSettings(false); requestAnimationFrame(() => trigger.current?.isConnected && trigger.current.focus()); };
    return <AccountContext.Provider value={{ identity, projectId, preferences, savePreferences, openSettings: element => { trigger.current = element; setSettings(true); }, switchProject, signOut, refreshIdentity }}>
        {children}{settings && <PanelBoundary fallback={<Modal title={t('设置')} onClose={close}><p role="alert">{t('设置加载失败，草稿仍保留。请刷新页面后重试。')}</p></Modal>}><Suspense fallback={<Modal title={t('设置')} busy onClose={() => {}}><p role="status">{t('正在加载…')}</p></Modal>}><SettingsDialog onClose={close}/></Suspense></PanelBoundary>}
    </AccountContext.Provider>;
}

export function AccountBar() {
    const account = useAccount();
    useLanguage();
    const [open, setOpen] = useState(false), [projects, setProjects] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
    const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState<CSSProperties>({ left: 8, bottom: 80, width: 260, maxHeight: 400 });
    const close = () => { setOpen(false); setProjects(false); trigger.current?.focus(); };
    useEffect(() => {
        if (!open) return;
        const place = () => { const box = trigger.current!.getBoundingClientRect(); const above = box.top > innerHeight - box.bottom; setPosition({ left: Math.max(8, Math.min(box.left, innerWidth - Math.max(240, box.width) - 8)), ...(above ? { bottom: innerHeight - box.top + 8 } : { top: box.bottom + 8 }), width: Math.min(Math.max(240, box.width), innerWidth - 16), maxHeight: Math.max(0, (above ? box.top : innerHeight - box.bottom) - 16) }); };
        const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(); };
        place(); panel.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
        window.addEventListener('resize', place); window.addEventListener('scroll', place, true); document.addEventListener('pointerdown', outside);
        return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); document.removeEventListener('pointerdown', outside); };
    }, [open, projects]);
    const perform = async (action: () => Promise<void>) => { setBusy(true); setError(''); try { await action(); close(); } catch (error: any) { setError(t(error.message)); } finally { setBusy(false); } };
    return <><button ref={trigger} className={'account-bar' + (open ? ' is-open' : '')} aria-label={t('账号菜单')} aria-haspopup="menu" aria-expanded={open} onClick={() => { if (open) close(); else { setError(''); setOpen(true); } }}><span className="avatar" aria-hidden="true">{account.identity.username.slice(0, 1).toUpperCase()}</span><span className="account-name" title={account.identity.username}>{account.identity.username}</span><Ellipsis size={19} aria-hidden="true"/></button>
        {open && createPortal(<div ref={panel} role="menu" aria-label={t('账号操作')} className="account-menu" style={position} onKeyDown={event => {
            event.stopPropagation();
            const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')];
            if (['Escape', 'Tab'].includes(event.key)) { event.preventDefault(); if (!busy) close(); }
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const index = items.indexOf(document.activeElement as HTMLElement); items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
        }}>
            {projects ? <><button role="menuitem" disabled={busy} onClick={() => setProjects(false)}>{t('返回账号菜单')}</button><div className="account-menu-divider" role="separator"/>{account.identity.projects.map(project => <button role="menuitem" key={project.id} disabled={busy} onClick={() => void perform(() => account.switchProject(project.id))}><Folder size={16}/><span>{project.name}</span>{project.id === account.projectId && <Check size={16}/>}</button>)}</> : <>
            <button role="menuitem" onClick={() => { close(); account.openSettings(trigger.current!); }}><Settings size={17}/><span>{t('设置')}</span></button>
            {account.identity.projects.length > 1 && <button role="menuitem" aria-haspopup="menu" onClick={() => setProjects(true)}><Folder size={17}/><span>{t('切换项目')}</span><ChevronRight size={15}/></button>}
            {account.identity.administrator && <a role="menuitem" href="/admin" target="_blank" rel="noopener" onClick={close}><ShieldCheck size={17}/><span>{t('平台管理')}</span><span aria-hidden="true">↗</span></a>}
            <div className="account-menu-divider" role="separator"/><button role="menuitem" disabled={busy} onClick={() => void perform(account.signOut)}><LogOut size={17}/><span>{busy ? t('正在保存…') : t('退出登录')}</span></button></>}
            {error && <p role="alert" className="account-error">{error}</p>}
        </div>, document.body)}
    </>;
}
