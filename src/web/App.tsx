import { randomUUID } from './uuid';
import { Schedule } from './Schedule';
import { useReadingNavigation } from './useReadingNavigation';
import { exportDocument } from './exportDocument';
import { WorkspaceIdentity } from './WorkspaceIdentity';
import { t } from './i18n';
import { useEffect, useState, lazy, Suspense } from 'react';
import { Modal } from './Modal';
import { Publish } from './Publish';
import { MergeWorkspace } from './MergeWorkspace';
import { Changes } from './Changes';

import './interactions.css';
import { BookOpen, ArrowLeft, ArrowRight, ChevronRight, FileText, ArrowUpRight, Check, Menu, PanelRight, Upload, Download, Sparkles, Link2, X, Search, Plus } from 'lucide-react';
import { api, apply, getSnapshot, navigate, notify, put, reload, useSnapshot } from './state';
import { Cell } from './CollectionView';
import { EntityMenuButton, CommandSurface } from './CommandSurface';
import { WriteControl } from './WriteControl';
import { TitleInput } from './TitleInput';
import { locked, registerBuffer, stepHistory, flushEditing } from './editing';
const DocumentEditor = lazy(() => import('./Editor').then(module => ({ default: module.DocumentEditor })));
import { Sidebar } from './Sidebar';
import { CollectionPanel } from './CollectionPanel';
import { deserialize, references, serialize, type Collection, type Entity } from '../shared/model';
import { viewFilters } from '../shared/viewQuery';
const tabLabels: Record<string, string> = { changes: '发布记录', schedule: '任务排期', inspiration: '灵感池' };
export function Login({ onLogin = reload }: { onLogin?: () => Promise<unknown> }) { const [error, setError] = useState(''), [busy, setBusy] = useState(false); return <div className="login"><aside><WorkspaceIdentity/><h1>{t("整理文档，协作编辑")}</h1><p>{t("在同一个地方编写文档、管理数据，")}<br/>{t("与团队和 Agent 一起完成工作。")}</p><div className="login-line"/><small>{t("自托管 · 文本资产 · 人机共同编辑")}</small></aside><form onSubmit={async (event) => { event.preventDefault(); setBusy(true); setError(''); const data = new FormData(event.currentTarget); try {
    await api('/login', Object.fromEntries(data));
    await onLogin();
}
catch (error: any) {
    setError(error.message);
}
finally {
    setBusy(false);
} }}><span className="eyebrow">{t("欢迎回来")}</span><h2>{t("登录工作台")}</h2><p className="muted">{t("个人草稿保持独立，灵感与团队共享。")}</p><label>{t("账号")}<input name="username" autoComplete="username" required autoFocus/></label><label>{t("密码")}<input name="password" type="password" autoComplete="current-password" required/></label>{error && <p className="error">{t(error)}</p>}<button className="primary" disabled={busy}>{busy ? t("正在登录…") : t("登录")}<ArrowUpRight size={16}/></button><small>{t("请使用管理员提供的账号；首次部署请先创建账号。")}</small></form></div>; }
export function App() {
    const snapshot = useSnapshot();
    const [navigationOpen, setNavigationOpen] = useState(false);
    const [loading, setLoading] = useState(true), [query, setQuery] = useState(''), [status, setStatus] = useState('已保存'), [right, setRight] = useState(true), [toast, setToast] = useState<{
        message: string;
        error?: boolean;
    } | null>(null), [merging, setMerging] = useState(false), [publishing, setPublishing] = useState(false), [jsonEditor, setJsonEditor] = useState<{
        title: string;
        text: string;
        save: (text: string) => Promise<unknown>;
    } | null>(null), [history, setHistory] = useState<any[]>([]), [connected, setConnected] = useState(false);
    const navigation = useReadingNavigation(snapshot, !loading);
    const { tab, selected, selectedCollection } = navigation.route;
    useEffect(() => { void reload().catch(() => {}).finally(() => setLoading(false)); const notice = (event: any) => setToast(event.detail); window.addEventListener('notice', notice); return () => window.removeEventListener('notice', notice); }, []);
    useEffect(() => { setQuery(''); setNavigationOpen(false); }, [navigation.route]);
    useEffect(() => { if (!toast)
        return; const timer = setTimeout(() => setToast(null), 7000); return () => clearTimeout(timer); }, [toast]);
    useEffect(() => { if (!snapshot)
        return; let stopped = false, socket: WebSocket, timer: ReturnType<typeof setTimeout>, cursor = snapshot.seq; const connect = () => { socket = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/events?since=' + cursor + '&projectId=' + encodeURIComponent(snapshot.project.id)); socket.onopen = () => { setConnected(true); void reload().catch(() => { }); }; socket.onmessage = event => { const change = JSON.parse(event.data); cursor = change.seq; void reload().catch(() => { }); window.dispatchEvent(new CustomEvent('server-event', { detail: change })); if (change.payload?.actor?.kind === 'agent')
        notify(t("Agent 正在更新草稿 · ") + change.payload.actor.username); }; socket.onclose = () => { setConnected(false); if (!stopped)
        timer = setTimeout(connect, 1000); }; }; connect(); return () => { stopped = true; clearTimeout(timer); socket?.close(); }; }, [snapshot?.actor.userId, snapshot?.project.id]);
    useEffect(() => {
        let active = true;
        if (snapshot && right)
            void api('/history').then(items => { if (active) setHistory(items); }).catch(() => { });
        return () => { active = false; };
    }, [snapshot?.actor.userId, snapshot?.workspace.version, right]);
    useEffect(()=>{
        const schema=(event:Event)=>{const entity=getSnapshot()?.tree[(event as CustomEvent).detail];if(entity?.kind==='collection')editSchema(entity);};
        const search=()=>{setNavigationOpen(true);requestAnimationFrame(()=>document.querySelector<HTMLInputElement>('.sidebar-search input')?.focus());};
        window.addEventListener('edit-schema',schema);window.addEventListener('workbench-search',search);
        return()=>{window.removeEventListener('edit-schema',schema);window.removeEventListener('workbench-search',search);};
    },[snapshot]);
    useEffect(()=>registerBuffer('schema-dialog',{dirty:()=>!!jsonEditor,flush:async()=>{if(jsonEditor)throw Error(t("请先保存或关闭结构编辑弹窗"));}}),[jsonEditor]);
    if (loading)
        return <div className="boot">{t("正在打开工作台…")}</div>;
    if (!snapshot)
        return <Login />;
    const selectedEntity = snapshot.tree[selected];
    const object = selectedEntity?.kind === 'object' ? selectedEntity : null;
    const collectionEntity = snapshot.tree[selectedCollection];
    const collection = collectionEntity?.kind === 'collection' ? collectionEntity : undefined;
    const views = Object.values(snapshot.tree).filter((entity): entity is import('../shared/model').CollectionView => entity.kind === 'view' && entity.collection === selectedCollection);
    const viewId = views.find(view => view.id === selected)?.id || views[0]?.id;
    const inWorkspace = tab === 'workspace' || tab === 'collections';
    const activeCollectionId = tab === 'collections' ? selectedCollection : tab === 'workspace' ? object?.collection || undefined : undefined;
    const switchTab = navigation.openTab;
    const createCollection = async () => { await flushEditing(); const title = prompt(t("集合名称")); if (!title?.trim()) return; const id = randomUUID(); await put({ id, kind: 'collection', title: title.trim(), path: '集合/' + id + '.json', fields: [] }, null); navigate(id); };

    const createDocument = async () => { if(locked())throw Error(t("请先收回控制权")); const title = prompt(t("页面标题")); if (!title?.trim())
        return; const id = randomUUID(); await put({ id, kind: 'object', path: '设计/' + id + '.md', title, collection: null, fields: {}, body: '# ' + title }, null); navigate(id); };
    const editSchema = (collection: Collection) => setJsonEditor({ title: t("集合结构 · ") + collection.title, text: JSON.stringify(collection.fields, null, 2), save: async (text) => { const fields = JSON.parse(text); const removed = collection.fields.filter(field => !fields.some((next: any) => next.key === field.key)); if (removed.length && !confirm(t("将删除字段及所有记录中的对应值：") + removed.map(field => field.label).join('、')))
            return; const operations: any[] = [{ type: 'put', entity: { ...collection, fields }, expected: collection }]; for (const entity of Object.values(getSnapshot()!.tree)) {
            if (entity.kind === 'object' && entity.collection === collection.id) {
                const values = { ...entity.fields };
                for (const field of removed)
                    delete values[field.key];
                operations.push({ type: 'put', entity: { ...entity, fields: values }, expected: entity });
            }
            if (entity.kind === 'view' && entity.collection === collection.id)
                operations.push({ type: 'put', entity: { ...entity, filter: null, filters: viewFilters(entity).filter(filter => !removed.some(field => field.key === filter.key)), sort: entity.sort && removed.some(field => field.key === entity.sort!.key) ? null : entity.sort, columns: entity.columns.filter(key => !removed.some(field => field.key === key)) }, expected: entity });
        } await apply(operations); } });
    const importFile = async (file: File) => { const text = await file.text(); let entity: Entity; try {
        entity = deserialize(text);
    }
    catch {
        const id = randomUUID();
        entity = { id, kind: 'object', title: file.name.replace(/\.md$/, ''), path: '导入/' + id + '.md', body: text, collection: null, fields: {} };
    } const preview = await api('/workspace/import-preview', entity); if (preview.normalized)
        notify(t("导入内容将按平台 Markdown 格式规范化，请检查预览")); setJsonEditor({ title: t("导入预览 · 检查规范化内容"), text: preview.text, save: async (content) => { const imported = deserialize(content); await put(imported, getSnapshot()!.tree[imported.id] || null); navigate(imported.id); } }); };
    return <div className="app-shell" data-history-scope={tab==='collections'?'collections':tab==='workspace'?selected:undefined}>
  <Sidebar snapshot={snapshot} tab={tab} selected={selected} collectionId={activeCollectionId} viewId={tab === 'collections' ? viewId : undefined} query={query} onSearch={setQuery} onTab={switchTab} createDocument={createDocument} createCollection={createCollection} open={navigationOpen} onClose={() => { setNavigationOpen(false); document.querySelector<HTMLButtonElement>('.navigation-toggle')?.focus(); }}/>
  <main><header className="topbar"><button className="icon navigation-toggle" aria-label={t("打开导航")} aria-expanded={navigationOpen} aria-controls="workspace-navigation" onClick={() => setNavigationOpen(!navigationOpen)}><Menu size={19}/></button><div className="reading-navigation" role="group" aria-label={t("阅读导航")}><button className="icon" aria-label={t("返回上一页")} title={t("返回上一页")} disabled={navigation.busy || navigation.index === 0} onClick={navigation.back}><ArrowLeft size={16}/></button><button className="icon" aria-label={t("前进到下一页")} title={t("前进到下一页")} disabled={navigation.busy || navigation.index >= navigation.length - 1} onClick={navigation.forward}><ArrowRight size={16}/></button></div><div className="breadcrumb" aria-label={t("当前位置")}><span>{inWorkspace ? t("我的草稿") : t("项目共享")}</span><ChevronRight size={13}/>{tab === 'workspace' && object?.collection && <><button onClick={() => navigate(object.collection!)}>{snapshot.tree[object.collection]?.title || t("集合")}</button><ChevronRight size={13}/></>}{tab === 'collections' && collection && viewId && <><button onClick={() => navigate(collection.id)}>{collection.title}</button><ChevronRight size={13}/></>}<strong>{tab === 'workspace' ? object?.title || t("页面") : tab === 'collections' ? snapshot.tree[viewId || '']?.title || collection?.title || t("集合") : t(tabLabels[tab])}</strong></div><div className="top-actions"><CommandSurface scope={tab==='collections'?'collections':tab==='workspace'?selected:undefined}/><span className={'connection ' + (connected ? 'online' : '')}>{connected ? t("实时连接") : t("正在重连")}</span>{inWorkspace && <button disabled={locked() || !snapshot.actor.scopes.includes('design.publish')} title={snapshot.actor.scopes.includes('design.publish') ? t("发布变更") : t("没有发布权限")} className="primary small" onClick={() => void flushEditing().then(()=>setPublishing(true)).catch(error=>notify(error.message,true))}>{t("发布变更")}<ArrowUpRight size={14}/></button>}</div></header>
  <WriteControl/>{!!snapshot.project.archived && <p className="project-archive-notice" role="status">{t("项目已归档，当前仅可查看。请联系管理员恢复项目后继续编辑。")}</p>}{inWorkspace && <div className={"revision-bar" + (snapshot.main !== snapshot.workspace.base ? " revision-behind" : "")}><BookOpen size={13}/><span title={t("草稿起点版本：") + snapshot.workspace.base}>{t("我的草稿 · 基于正式版本")}</span>{snapshot.main !== snapshot.workspace.base ? <><span role="status">⚠ {t("个人草稿落后于正式版本")}</span><button className="revision-merge-button" disabled={locked() || !snapshot.actor.scopes.includes("workspace.write")} onClick={() => void flushEditing().then(() => setMerging(true)).catch(error => notify(error.message, true))}>{t("合入最新正式设计")}</button></> : <span>{t("已包含团队最新设计")}</span>}<div className="spacer"/><span className={status === '已保存' ? 'saved' : 'pending'}>{status === '已保存' && <Check size={13}/>} {t(status)}</span><button className="icon" title={t("属性与活动")} aria-pressed={right} onClick={() => setRight(!right)}><PanelRight size={15}/></button></div>}
  <div className="workspace-body"><section className={'content' + (tab === 'workspace' && object ? ' content-document' : '')}>
   {tab === 'workspace' && (object ? <Suspense fallback={<div className="empty">{t("正在加载编辑器…")}</div>}><DocumentEditor key={object.id} id={object.id} onStatus={setStatus} heading={<div className="page-heading"><span className="eyebrow">{object.collection ? t("集合记录") : t("设计文档")} / {object.path.split('/').slice(0, -1).join('/')}</span><TitleInput key={object.id} object={object}/><div className="page-meta"><span>Markdown</span><span>{t("人和 Agent 共同编辑")}</span><button disabled={locked()} onClick={() => { const path = prompt(t("目标路径（含文件名）"), object.path); if (path)
        void put({ ...object, path }, object).catch(error => notify(error.message, true)); }}>{t("移动 / 重命名")}</button><button onClick={() => void exportDocument(object.id).catch(error => notify(error.message, true))}><Download size={12}/>{t("导出")}</button><label className="import-button"><Upload size={12}/>{t("导入")}<input disabled={locked()} type="file" accept=".md,.json" aria-label={t("导入页面文件")} className="import-file-input" onChange={event => { const file = event.target.files?.[0]; if (file)
        void importFile(file).catch(error => notify(error.message, true)); event.target.value = ''; }}/></label></div></div>}/></Suspense> : <div className="empty spacious"><BookOpen size={36}/><h2>{t("从一页设计开始")}</h2><p>{t("选择左侧文档，或创建一份新的草稿。")}</p><button className="primary" onClick={() => void createDocument()}>{t("新建页面")}</button></div>)}

   {tab === 'schedule' && (snapshot.actor.scopes.includes('schedule.read') ? <Schedule key={snapshot.project.id + ':' + snapshot.actor.userId}/> : <div className="page-panel">{t('没有任务排期查看权限，请联系管理员。')}</div>)}
   {tab === 'collections' && <CollectionPanel collection={collection} views={views} viewId={viewId} editSchema={editSchema}/>}
   {tab === 'inspiration' && (snapshot.actor.scopes.includes('inspiration.read') ? <Inspiration /> : <div className="page-panel">{t("没有灵感池查看权限，请联系管理员。")}</div>)}{tab === 'changes' && <Changes canSync={snapshot.actor.canSync}/>}
  </section>{right && (tab === 'workspace' || tab === 'collections') && <aside className="inspector"><div className="inspector-heading">{tab === 'collections' ? t("集合操作历史") : t("页面上下文")}</div>{tab === 'workspace' && object && <><span className="eyebrow">{t("属性")}</span><dl><dt>{t("对象 ID")}</dt><dd className="mono">{object.id}</dd><dt>{t("所属集合")}</dt><dd>{object.collection ? snapshot.tree[object.collection]?.title : t("独立页面")}</dd></dl>{object.collection && snapshot.tree[object.collection]?.kind === 'collection' && (snapshot.tree[object.collection] as Collection).fields.map(field => <label className="property" key={field.key}><span>{field.label}</span><Cell row={object} field={field}/></label>)}<div className="inspector-divider"/><span className="eyebrow"><Link2 size={13}/>{t("反向链接")}</span>{Object.values(snapshot.tree).filter(entity => references(entity).includes(object.id)).map(entity => <button className="backlink" key={entity.id} onClick={() => navigate(entity.id)}><FileText size={13}/>{entity.title}</button>)}<div className="inspector-divider"/></>}<span className="eyebrow"><Sparkles size={13}/>{t("最近操作")}</span><div className="activity-list">{history.filter(operation=>operation.state!=='abandoned').slice(0, 12).map(operation => <article key={operation.id}><span className={'actor-dot ' + operation.actor.kind}/><div><strong>{operation.actor.kind === 'agent' ? 'Agent' : operation.actor.username}</strong>{['revoked','expired'].includes(operation.writeState)&&<small className="muted">{t("写入中断 · 已保存部分可撤销")}</small>}<p>{operation.diff[0]?.kind} · {operation.diff[0]?.title} · {operation.diff.length} {t("处变化")}</p><button disabled={locked()} onClick={() => void stepHistory(operation.state==='undone'?'redo':'undo',undefined,operation.group_id)}>{operation.state==='undone'?t("重做变更组"):t("撤销变更组")}</button></div></article>)}</div>{tab === 'workspace' && object && <EntityMenuButton id={object.id} title={object.title}/>}</aside>}</div>
  </main>{toast && <div role="status" className={'toast ' + (toast.error ? 'error' : '')}>{t(toast.message)}<button className="icon" onClick={() => setToast(null)}><X size={14}/></button></div>}{publishing && <Publish onClose={() => setPublishing(false)} onMerge={() => setMerging(true)}/>} {merging && <MergeWorkspace onClose={() => setMerging(false)}/>} {jsonEditor && <Modal title={jsonEditor.title} onClose={() => setJsonEditor(null)}><p className="muted">{t("这是权威结构的编辑入口；保存时进行事务校验，失败不会部分修改。")}</p><textarea className="code-editor" value={jsonEditor.text} onChange={event => setJsonEditor({ ...jsonEditor, text: event.target.value })}/><button className="primary" onClick={() => void jsonEditor.save(jsonEditor.text).then(() => setJsonEditor(null)).catch(error => notify(error.message + (error.details ? '：' + JSON.stringify(error.details) : ''), true))}>{t("确认保存")}</button></Modal>}
 </div>;
}
export function Inspiration({ scopes = getSnapshot()?.actor.scopes || [] }: { scopes?: string[] }) { const [notes, setNotes] = useState<any[]>([]), [query, setQuery] = useState(''), [editing, setEditing] = useState<any>(null); const load = () => api('/inspiration?q=' + encodeURIComponent(query)).then(setNotes).catch(error => notify(error.message, true)); useEffect(() => { void load(); const listener = () => void load(); window.addEventListener('server-event', listener); return () => window.removeEventListener('server-event', listener); }, [query]); return <div className="page-panel inspiration"><div className="section-heading"><div><span className="eyebrow">A PLACE FOR POSSIBILITIES</span><h1>{t("共享灵感池")}<span className="hand-dot">.</span></h1><p>{t("不必完整，不急着成为规则。这里的想法不参与版本和发布。")}</p></div><button className="primary" disabled={!scopes.includes('inspiration.write')} title={scopes.includes('inspiration.write') ? t("新建便签") : t("仅可查看灵感池")} onClick={() => setEditing({ title: '', body: '', tags: [] })}><Plus size={16}/>{t("记下灵感")}</button></div><div className="note-toolbar"><Search size={16}/><input aria-label={t("搜索灵感池")} placeholder={t("只搜索共享便签…")} value={query} onChange={event => setQuery(event.target.value)}/><span>{t("项目成员共享 · 独立于正式设计")}</span></div><div className="note-grid">{notes.map((note, index) => <article className={'note tone-' + index % 3} key={note.id}><small>{note.tags.join(' / ') || t("随手记录")}</small><h2><button onClick={() => setEditing(note)}>{note.title}</button></h2><p>{note.body}</p><footer><span>{note.editor} · {new Date(note.updated).toLocaleDateString()}</span><button disabled={!scopes.includes('workspace.write')} title={t("复制到我的草稿")} onClick={() => void api('/inspiration/promote', { requestId: randomUUID(), id: note.id, version: note.version }).then(async (result) => { await reload(); navigate(result.entityId); notify(t("已复制到个人草稿，原便签保留")); }).catch(error => notify(error.message, true))}><ArrowUpRight size={16}/></button></footer></article>)}</div>{!notes.length && <div className="empty">{t("没有便签。写下第一个想法吧。")}</div>}{editing && <Modal title={!scopes.includes('inspiration.write') ? t("查看共享便签") : editing.id ? t("编辑共享便签") : t("记下一个想法")} onClose={() => setEditing(null)}><label>{t("标题")}<input readOnly={!scopes.includes('inspiration.write')} value={editing.title} onChange={event => setEditing({ ...editing, title: event.target.value })}/></label><label>{t("内容（Markdown）")}<textarea readOnly={!scopes.includes('inspiration.write')} rows={10} value={editing.body} onChange={event => setEditing({ ...editing, body: event.target.value })}/></label><label>{t("标签，以逗号分隔")}<input readOnly={!scopes.includes('inspiration.write')} value={editing.tags.join(',')} onChange={event => setEditing({ ...editing, tags: event.target.value.split(',') })}/></label><div className="actions"><button className="primary" disabled={!scopes.includes('inspiration.write')} onClick={() => void api('/inspiration', { ...editing, requestId: randomUUID() }).then(() => { setEditing(null); return load(); }).catch(error => notify(error.message + t("；内容保留，请关闭后重新读取"), true))}>{t("保存便签")}</button>{editing.id && <button className="danger" disabled={!scopes.includes('inspiration.write')} onClick={() => { if (confirm(t("删除共享便签？")))
    void api('/inspiration', { ...editing, requestId: randomUUID(), remove: true }).then(() => { setEditing(null); return load(); }).catch(error => notify(error.message, true)); }}>{t("删除")}</button>}</div></Modal>}</div>; }
