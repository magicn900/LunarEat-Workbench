import { WorkspaceIdentity } from './WorkspaceIdentity';
import { t } from './i18n';
import { shortcutLabel, useShortcuts } from './shortcuts';
import { useEffect, useRef, useState } from 'react';
import { BookOpen, Boxes, ChevronDown, ChevronRight, FilePlus2, FolderPlus, LayoutGrid, List, Plus, Search, StickyNote, Table2, X } from 'lucide-react';
import { type Snapshot, navigate, notify } from './state';
import { DirectoryTree, createFolder } from './DirectoryTree';
import { EntityMenuButton } from './CommandSurface';
import { locked } from './editing';
import { AccountBar } from './Account';
import type { Collection, CollectionView as View } from '../shared/model';

function NewContentMenu({ createDocument, createCollection }: { createDocument: () => Promise<void>; createCollection: () => Promise<void> }) {
    const [open, setOpen] = useState(false);
    const container = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (!open) return;
        container.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
        const outside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
        document.addEventListener('pointerdown', outside);
        return () => document.removeEventListener('pointerdown', outside);
    }, [open]);
    const close = () => { setOpen(false); trigger.current?.focus(); };
    return <div className="new-content" ref={container} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        if (!open || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }}>
        <button ref={trigger} className="icon" aria-label={t("新建内容")} title={t("新建页面、文件夹或集合")} aria-haspopup="menu" aria-expanded={open} disabled={locked()} onClick={() => setOpen(!open)}><Plus size={16}/></button>
        {open && <div role="menu" aria-label={t("新建内容")} className="new-content-menu">
            {[{ label: t("新建页面"), Icon: FilePlus2, run: createDocument }, { label: t("新建文件夹"), Icon: FolderPlus, run: createFolder }, { label: t("新建集合"), Icon: Boxes, run: createCollection }].map(({ label, Icon, run }) => <button key={t(label)} role="menuitem" disabled={locked()} onClick={() => { close(); void Promise.resolve().then(run).catch(error => notify(error.message, true)); }}><Icon size={15}/>{t(label)}</button>)}
        </div>}
    </div>;
}

function CollectionEntry({ collection, views, active, selectedView, isDestination }: { collection: Collection; views: View[]; active: boolean; isDestination: boolean; selectedView?: string }) {
    const [expanded, setExpanded] = useState(active);
    useEffect(() => { if (active) setExpanded(true); }, [active, selectedView]);
    return <div className="collection-nav-entry" data-history-scope={collection.id}>
        <div className={'collection-nav-row nav-tree-row' + (active ? ' ancestor' : '')} data-entity-id={collection.id}>
            <button className="icon disclosure" aria-label={(expanded ? t("折叠") : t("展开")) + t("集合 ") + collection.title} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}</button>
            <button className={'nav-item collection-link' + (active && isDestination && !selectedView ? ' current' : '')} aria-current={active && isDestination && !selectedView ? 'page' : undefined} title={collection.title} onClick={() => navigate(collection.id)}><Boxes size={16}/><span>{collection.title}</span></button>
            <EntityMenuButton id={collection.id} title={collection.title}/>
        </div>
        {expanded && <div className="collection-view-links">{views.map(view => {
            const Icon = view.layout === 'cards' ? LayoutGrid : view.layout === 'list' ? List : Table2;
            return <div className="view-nav-row nav-tree-row nav-tree-leaf" key={view.id} data-entity-id={view.id}><button className={'nav-item' + (selectedView === view.id ? ' current' : '')} aria-current={selectedView === view.id ? 'page' : undefined} title={view.title} onClick={() => navigate(view.id)}><Icon size={16}/><span>{view.title}</span></button><EntityMenuButton id={view.id} title={view.title}/></div>;
        })}{!views.length && <span className="nav-hint">{t("尚无视图，打开集合创建")}</span>}</div>}
    </div>;
}

export function Sidebar({ snapshot, tab, selected, collectionId, viewId, query, onSearch, onTab, createDocument, createCollection, open, onClose }: {
    snapshot: Snapshot; tab: string; selected: string; collectionId?: string; viewId?: string; query: string;
    onSearch: (query: string) => void; onTab: (tab: string) => void; createDocument: () => Promise<void>; createCollection: () => Promise<void>; open: boolean; onClose: () => void;
}) {
    const sidebar = useRef<HTMLElement>(null);
    useShortcuts();
    useEffect(() => {
        if (open && window.matchMedia('(max-width: 760px)').matches) sidebar.current?.querySelector<HTMLInputElement>('input')?.focus();
    }, [open]);
    const entities = Object.values(snapshot.tree);
    const collections = entities.filter((entity): entity is Collection => entity.kind === 'collection');
    const pages = entities.filter(entity => entity.kind === 'folder' || entity.kind === 'object' && !entity.collection).sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'));
    const matching = query.trim() ? entities.filter(entity => entity.kind === 'object' && (entity.title + ' ' + entity.path + ' ' + entity.body + ' ' + JSON.stringify(entity.fields)).toLowerCase().includes(query.trim().toLowerCase())) : [];
    const shared = [['changes', '发布记录', BookOpen], ['inspiration', '灵感池', StickyNote]] as const;
    return <>
        {open && <button className="sidebar-backdrop" aria-label={t("关闭侧栏遮罩")} onClick={onClose}/>}
        <aside ref={sidebar} id="workspace-navigation" className={'sidebar workspace-sidebar' + (open ? ' is-open' : '')} aria-label={t("项目导航")} onKeyDown={event => {
            if (!event.currentTarget.contains(event.target as Node)) return;
            if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
            if (event.key !== 'Tab' || !open || !window.matchMedia('(max-width: 760px)').matches) return;
            const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input, summary')].filter(element => element.checkVisibility());
            const first = controls[0], last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}>
            <div className="sidebar-brand"><WorkspaceIdentity projectName={snapshot.project.name}/><button className="icon sidebar-close" aria-label={t("关闭导航")} onClick={onClose}><X size={18}/></button></div>
            <label className="search sidebar-search"><Search size={15}/><input aria-label={t("搜索策划")} placeholder={t("搜索策划…")} value={query} onChange={event => onSearch(event.target.value)}/>{query ? <button className="icon" aria-label={t("清除策划搜索")} onClick={() => onSearch('')}><X size={13}/></button> : <kbd title={shortcutLabel('search')}>⌕</kbd>}</label>
            <div className="sidebar-content" data-history-scope="workspace">
                {query.trim() ? <section className="search-results" aria-label={t("策划搜索结果")}><div className="scope-heading">{t("搜索结果")} <span>{matching.length}</span></div>{matching.map(entity => <div className="search-result" data-entity-id={entity.id} key={entity.id}><button className="nav-item" onClick={() => navigate(entity.id)}><BookOpen size={15}/><span>{entity.title}<small>{entity.kind === 'object' && entity.collection ? snapshot.tree[entity.collection]?.title : t("独立页面")}</small></span></button><EntityMenuButton id={entity.id} title={entity.title}/></div>)}{!matching.length && <p className="nav-hint">{t("没有匹配的策划内容")}</p>}<p className="nav-hint">{t("不包含共享灵感池")}</p></section> : <>
                    <div className="scope-heading"><span>{t("我的草稿")}</span><NewContentMenu createDocument={createDocument} createCollection={createCollection}/></div>
                    <p className="draft-hint">{t("自动保存，发布后更新团队正式设计")}</p>
                    <details className="nav-group" open><summary className="nav-tree-row"><ChevronRight size={13}/><BookOpen size={16}/><span>{t("页面")}</span></summary><div className="file-list"><DirectoryTree entities={pages} selected={tab === 'workspace' ? selected : ''}/>{!pages.length && <p className="nav-hint">{t("从右上角 ＋ 创建第一篇页面")}</p>}</div></details>
                    <details className="nav-group" open><summary className="nav-tree-row"><ChevronRight size={13}/><Boxes size={16}/><span>{t("结构化集合")}</span></summary><div className="collection-navigation">{collections.map(collection => <CollectionEntry key={collection.id} collection={collection} views={entities.filter((entity): entity is View => entity.kind === 'view' && entity.collection === collection.id)} isDestination={tab === 'collections'} active={collectionId === collection.id} selectedView={viewId}/>)}{!collections.length && <p className="nav-hint">{t("还没有集合")}</p>}</div></details>
                </>}
            </div>
            <div className="shared-navigation"><div className="scope-heading">{t("项目共享")}</div><nav aria-label={t("项目共享")}>{shared.filter(([key]) => key !== 'inspiration' || snapshot.actor.scopes.includes('inspiration.read')).map(([key, label, Icon]) => <button key={key} className={'nav-item' + (tab === key ? ' current' : '')} aria-current={tab === key ? 'page' : undefined} onClick={() => onTab(key)}><Icon size={16}/><span>{t(label)}</span>{key === 'inspiration' && <small>{t("不纳入版本")}</small>}</button>)}</nav></div>
            <div className="sidebar-utilities"><AccountBar/></div>
        </aside>
    </>;
}
