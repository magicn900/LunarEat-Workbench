import { randomUUID } from './uuid';
import { TextCell } from './TextCell';
import { t } from './i18n';
import { useState, useEffect, useRef, useId } from 'react';
import { locked, flushEditing, afterEditing, registerBuffer, editingChanged } from './editing';
import { EntityMenuButton } from './CommandSurface';
import { Plus, Table2, List, LayoutGrid } from 'lucide-react';
import { queryViewResult, type CollectionView as View, type DesignObject, type Collection, type Field } from '../shared/model';
import { useSnapshot, getSnapshot, put, apply, notify, navigate } from './state';
import { viewFilters } from '../shared/viewQuery';
import { ColumnFilter, FilterChips, ViewPagination } from './ViewControls';
import { ViewSearch } from './ViewSearch';
import { updateView } from './viewWrites';
export function Cell({ row, field }: { row: DesignObject; field: Field }) {
    useSnapshot();
    const original:unknown=row.fields[field.key] ?? null;
    const format=(value:unknown)=>Array.isArray(value)?value.join(', '):String(value??'');
    const [value,setValue]=useState(format(original)), [dirty,setDirty]=useState(false);
    const bufferId=useId();
    const pending=useRef<Promise<void>|null>(null);
    const baseline=useRef(original);
    if(!dirty&&!pending.current)baseline.current=original;
    const state=useRef({value,dirty,original});
    state.current={value,dirty,original:baseline.current};
    useEffect(()=>{if(!state.current.dirty&&!pending.current)setValue(format(original));},[original]);
    const save=async(raw:string)=>{
        if(pending.current) return pending.current;
        pending.current=(async()=>{
            try {
                do {
                    const submitted = raw;
                    let next:unknown=submitted===''?null:submitted;
                    if(field.type==='number' && submitted!=='')next=Number(submitted);
                    if(field.type==='boolean')next=submitted==='true';
                    if(field.type==='multi')next=submitted.split(',').map(item=>item.trim()).filter(Boolean);
                    await apply([{type:'field',id:row.id,key:field.key,expected:state.current.original,value:next}]);
                    baseline.current=next;
                    state.current.original=next;
                    if(state.current.value===submitted){state.current.dirty=false;setDirty(false);}
                    raw=state.current.value;
                } while(state.current.dirty);
            }
            catch(error:any){notify(error.message+'；输入已保留',true);throw error;}
            finally{pending.current=null;editingChanged();}
        })();
        return pending.current;
    };
    useEffect(()=>registerBuffer('cell:'+bufferId,{dirty:()=>state.current.dirty||!!pending.current,flush:async()=>{if(pending.current)await pending.current;else if(state.current.dirty)await save(state.current.value);}}),[bufferId,row.id,field.key]);
    const edit=(raw:string)=>{state.current.value=raw;state.current.dirty=true;setValue(raw);setDirty(true);editingChanged();};
    const label=row.title+' '+field.label;
    if(['text','multi','reference'].includes(field.type))return <TextCell readOnly={locked()} aria-label={label} value={value} onChange={event=>edit(event.target.value)} onBlur={()=>{if(state.current.dirty)void save(state.current.value).catch(()=>{});}} onKeyDown={event=>{if(event.key==='Enter'&&(field.type!=='text'||event.ctrlKey||event.metaKey)&&!event.nativeEvent.isComposing){event.preventDefault();event.currentTarget.blur();}}} placeholder="—"/>;
    if(field.type==='boolean')return <input disabled={locked()} aria-label={label} type="checkbox" checked={value==='true'} onChange={event=>{edit(String(event.target.checked));void save(String(event.target.checked)).catch(()=>{});}}/>;
    if(field.type==='select')return <select disabled={locked()} aria-label={label} value={value} onChange={event=>{edit(event.target.value);void save(event.target.value).catch(()=>{});}}><option value="">{t("未设置")}</option>{field.options?.map(option=><option key={option}>{option}</option>)}</select>;
    return <input readOnly={locked()} aria-label={label} type={field.type==='number'?'number':field.type==='date'?'date':'text'} value={value} onChange={event=>edit(event.target.value)} onBlur={()=>{if(state.current.dirty)void save(state.current.value).catch(()=>{});}} onKeyDown={event=>{if(event.key==='Enter'&&!event.nativeEvent.isComposing)event.currentTarget.blur();}} placeholder="—"/>;
}
export function CollectionGrid({ viewId, compact = false }: { viewId: string; compact?: boolean }) {
    const snapshot = useSnapshot();
    if (!snapshot) return null;
    const view = snapshot.tree[viewId];
    if (view?.kind !== 'view') return <div className="empty">{t("视图不存在：")}{viewId}</div>;
    const collection = snapshot.tree[view.collection];
    if (collection?.kind !== 'collection') return <div className="empty">{t("集合不存在")}</div>;
    return <ResolvedGrid view={view} collection={collection} tree={snapshot.tree} compact={compact}/>;
}
function ResolvedGrid({ view, collection, tree, compact }: { view: View; collection: Collection; tree: import('../shared/model').Tree; compact: boolean }) {
    const [paging, setPaging] = useState({ key: '', page: 1 });
    const configKey = JSON.stringify([view.id, viewFilters(view), view.sort, view.search, view.pagination, view.layout]);
    const result = queryViewResult(tree, view, paging.key === configKey ? paging.page : 1);
    const allFields: Field[] = [{ key: 'title', label: t('名称'), type: 'text', required: true }, ...collection.fields];
    const fields = view.columns.filter(key => key !== 'title').map(key => collection.fields.find(field => field.key === key)).filter((field): field is Field => !!field);
    const persist = (patch: Partial<View>) => updateView(view.id, patch);
    const change = (patch: Partial<View>) => afterEditing(() => persist(patch));
    const go = (page: number) => { void flushEditing().then(() => setPaging({ key: configKey, page })).catch(error => notify(error.message, true)); };
    const add = async () => { await flushEditing(); const title = prompt(t("新记录名称")); if (!title?.trim()) return; const id = randomUUID(); await put({ id, kind: 'object', path: '记录/' + id + '.md', title, collection: collection.id, fields: {}, body: '' }, null); notify(t("已新增记录；如被当前筛选隐藏，可清除筛选后查看")); };
    return <section className={'collection-grid ' + (compact ? 'embedded' : '')} data-view={view.id} data-entity-id={view.id} data-history-scope={collection.id} tabIndex={0}>
        <header><span className="eyebrow">{t("集合视图")}</span><strong>{view.title}</strong><span className="count">{result.filteredCount}</span><div className="spacer"/>{[['table', Table2], ['list', List], ['cards', LayoutGrid]].map(([layout, Icon]: any) => <button disabled={locked()} key={layout} className={'icon ' + (view.layout === layout ? 'active' : '')} aria-pressed={view.layout === layout} title={layout === 'table' ? t("表格") : layout === 'list' ? t("列表") : t("卡片")} onClick={() => void change({ layout }).catch(() => {})}><Icon size={15}/></button>)}<button disabled={locked()} className="small" onClick={() => void add().catch(error => notify(error.message, true))}><Plus size={14}/>{t("记录")}</button><EntityMenuButton id={view.id} title={view.title}/></header>
        <div className="view-tools"><ViewSearch value={view.search || ''} save={persist}/>{!compact && <button disabled={locked()} className="small" onClick={() => { const columns = prompt(t("可见字段（英文标识，以逗号分隔）"), view.columns.join(',')); if (columns) void change({ columns: columns.split(',').map(key => key.trim()).filter(Boolean) }).catch(() => {}); }}>{t("显示字段")}</button>}{view.layout !== 'table' && <div className="list-filters">{allFields.map(field => <ColumnFilter key={field.key} field={field} view={view} tree={tree} change={persist}/>)}</div>}</div>
        <FilterChips view={view} fields={allFields} tree={tree} change={change}/>
        {view.layout === 'table' ? <div className="table-scroll"><table><thead><tr>{[allFields[0], ...fields].map(field => <th key={field.key}><ColumnFilter field={field} view={view} tree={tree} change={persist}/></th>)}<th aria-label={t("操作")}/></tr></thead><tbody>{result.rows.map(row => <tr key={row.id} data-entity-id={row.id} tabIndex={0}><td><button className="row-title" onClick={() => navigate(row.id)}>{row.title}</button></td>{fields.map(field => <td key={field.key}><Cell row={row} field={field}/></td>)}<td><EntityMenuButton id={row.id} title={row.title}/></td></tr>)}</tbody></table></div> : <div className={view.layout === 'cards' ? 'record-cards' : 'record-list'}>{result.rows.map(row => <article key={row.id} data-entity-id={row.id} tabIndex={0}><button className="row-title" onClick={() => navigate(row.id)}>{row.title}</button>{fields.map(field => <label key={field.key}><span>{field.label}</span><Cell row={row} field={field}/></label>)}<EntityMenuButton id={row.id} title={row.title}/></article>)}</div>}
        {!result.rows.length && <div className="empty">{result.totalCount ? t("没有符合当前条件的记录，可清除筛选。") : t("还没有记录，创建第一条。")}</div>}
        <ViewPagination result={result} view={view} change={change} go={go}/>
    </section>;
}
