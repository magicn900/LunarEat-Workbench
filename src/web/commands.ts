import { t } from './i18n';
import { apply, getSnapshot, navigate, put, notify } from './state';
import { deleteEntity } from './DeleteEntity';
import { flushEditing, locked, stepHistory } from './editing';
import { deletionBlockers } from '../shared/deletion';
export type Target = { id?: string; directory?: string };
export type Command = { id: string; label: string; shortcut?: string; danger?: boolean; disabled?: boolean; run: () => unknown | Promise<unknown> };
export function dispatch(name: string, detail?: unknown) { window.dispatchEvent(new CustomEvent(name,{detail})); }
export async function execute(command: Command) {
    if(command.disabled)return;
    try {await command.run();}catch(error:any){notify(error.message,true);}
}
export async function createCollectionView(collectionId: string) {
    await flushEditing();
    const collection = getSnapshot()?.tree[collectionId];
    if (collection?.kind !== 'collection') throw Error(t("集合已删除或不存在"));
    const id = crypto.randomUUID();
    await put({ id, kind: 'view', title: collection.title + '视图', path: '视图/' + id + '.json', collection: collection.id, layout: 'table', columns: ['title', ...collection.fields.map(field => field.key)], filter: null, sort: null }, null);
    navigate(id);
}
export function commands(target: Target, scope?: string): Command[] {
    const snapshot=getSnapshot();
    if(!snapshot)return [];
    const entity=target.id?snapshot.tree[target.id]:null;
    const disabled=locked();
    const historyScope=scope || (entity?entity.id:target.directory?'workspace':undefined);
    const result:Command[]=[];
    if(entity){
        if(entity.kind==='object')result.push({id:'open',label:t("打开记录"),run:()=>navigate(entity.id)});
        result.push({id:'rename',label:t("重命名"),shortcut:'F2',disabled,run:async()=>{await flushEditing();const current=getSnapshot()!.tree[entity.id];const title=prompt(t("新名称"),current.title);if(title?.trim())await put({...current,title:title.trim()},current);}});
        if(entity.kind==='collection')result.push({id:'schema',label:t("编辑字段结构"),disabled,run:()=>dispatch('edit-schema',entity.id)},{id:'add-view',label:t("新增视图"),disabled,run:()=>createCollectionView(entity.id)});
        if(entity.kind==='view'){
            for(const [layout,title] of [['table','表格'],['list','列表'],['cards','卡片']] as const)result.push({id:'layout-'+layout,label:t("切换为")+title,disabled:disabled||entity.layout===layout,run:()=>put({...entity,layout},entity)});
            result.push({id:'columns',label:t("配置显示字段"),disabled,run:()=>{const columns=prompt(t("可见字段标识，以逗号分隔"),entity.columns.join(','));if(columns!==null)return put({...entity,columns:columns.split(',').map(item=>item.trim()).filter(Boolean)},entity);}});
        }
        if(entity.kind==='object')result.push({id:'duplicate',label:t("复制记录"),disabled,run:()=>{const id=crypto.randomUUID();return put({...entity,id,title:entity.title+' 副本',path:'记录/'+id+'.md'},null);}},{id:'copy-link',label:t("复制内部链接"),run:()=>navigator.clipboard.writeText('['+entity.title+'](doc:'+entity.id+')')},{id:'move',label:t("移动页面"),disabled,run:()=>{const path=prompt(t("目标文件路径"),entity.path);if(path?.trim())return put({...entity,path:path.trim()},entity);}});
        result.push({id:'delete',label:entity.kind==='collection'?t("删除集合"):entity.kind==='view'?t("删除视图"):t("删除记录"),shortcut:'Delete',danger:true,disabled,run:()=>deleteEntity(entity)});
    }else if(target.directory){
        const path=target.directory;
        result.push({id:'rename',label:t("移动／重命名目录"),shortcut:'F2',disabled,run:()=>{const to=prompt(t("新的目录路径"),path);if(to&&to!==path)return apply([{type:'directory',from:path,to,head:getSnapshot()!.workspace.head}]);}},
        {id:'new-page',label:t("新建子页面"),disabled,run:()=>{const title=prompt(t("页面标题"));if(!title?.trim())return;const id=crypto.randomUUID();return put({id,kind:'object',title,path:path+'/'+id+'.md',collection:null,fields:{},body:'# '+title},null);}},
        {id:'new-folder',label:t("新建子目录"),disabled,run:()=>{const title=prompt(t("子目录名称"));if(!title?.trim())return;const id=crypto.randomUUID();return put({id,kind:'folder',title,path:path+'/'+title+'/__directory.json'},null);}},
        {id:'delete',label:t("删除目录"),shortcut:'Delete',danger:true,disabled,run:async()=>{await flushEditing();const current=getSnapshot()!;const ids=new Set(Object.values(current.tree).filter(entity=>entity.path.startsWith(path+'/')).map(entity=>entity.id));if(deletionBlockers(current.tree,ids).length)throw Error(t("目录内容被外部引用，请先解除引用"));if(confirm(t("删除目录及其中 ")+ids.size+t(" 个对象？可撤销。")))await apply([{type:'directory',from:path,to:null,head:current.workspace.head}]);}});
    }
    result.push({id:'undo',label:t("撤销"),shortcut:'Ctrl+Z',disabled:disabled||!historyScope,run:()=>stepHistory('undo',historyScope)},{id:'redo',label:t("重做"),shortcut:'Ctrl+Shift+Z',disabled:disabled||!historyScope,run:()=>stepHistory('redo',historyScope)});
    return [...result.filter(command=>!command.danger),...result.filter(command=>command.danger)];
}
