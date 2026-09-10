import { t } from './i18n';
import { shortcutLabel } from './shortcuts';
import { deletionBlockers, deletionTargets } from '../shared/deletion';
import type { Entity } from '../shared/model';
import { apply, getSnapshot, notify } from './state';
import { flushEditing, locked } from './editing';

export async function deleteEntity(entity: Entity) {
    if(locked())throw Error(t("请先等待 Agent 完成或收回控制权"));
    await flushEditing();
    const snapshot=getSnapshot();
    if(!snapshot)return;
    const current=snapshot.tree[entity.id];
    if(!current)throw Error(t("对象已不存在"));
    const targets=deletionTargets(snapshot.tree,current);
    const blockers=deletionBlockers(snapshot.tree,new Set(targets.map(target=>target.id)));
    if(blockers.length) {alert('暂不能删除，请先移除以下页面中的链接、嵌入或引用：\n'+blockers.map(item=>item.title+'（'+item.path+'）').join('\n'));return;}
    const label=current.kind==='collection'?'集合':current.kind==='view'?'视图':'记录';
    const scope=current.kind==='collection'?'同时删除 '+targets.filter(item=>item.kind==='object').length+' 条记录和 '+targets.filter(item=>item.kind==='view').length+' 个视图。':current.kind==='view'?'只删除视图，不删除记录。':'此记录会从所有共享视图中消失。';
    if(!confirm(t("删除")+label+'「'+current.title+'」？\n'+scope+t("\n可通过操作历史撤销。")))return;
    await apply(targets.map(target=>({type:'delete',id:target.id,expected:target})));
    notify(t('已删除') + (shortcutLabel('undo') ? ' · ' + shortcutLabel('undo') + ' ' + t('撤销') : ''));
}
