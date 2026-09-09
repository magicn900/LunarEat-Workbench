import { t } from './i18n';
import { api, getSnapshot, reload, notify } from './state';

const buffers = new Map<string,{ dirty: () => boolean; flush: () => Promise<void> }>();
export function editingChanged() { window.dispatchEvent(new Event('editing-state')); }
export function registerBuffer(id: string, buffer: { dirty: () => boolean; flush: () => Promise<void> }) {
    buffers.set(id,buffer);
    return () => { buffers.delete(id); editingChanged(); };
}
export function hasPendingInput() { return [...buffers.values()].some(buffer=>buffer.dirty()); }
export function afterEditing(action: () => Promise<void>): Promise<void> {
    const preceding = [...buffers.values()];
    let pending = true;
    const promise = Promise.resolve().then(async () => {
        for (const buffer of preceding) if (buffer.dirty()) await buffer.flush();
        if (preceding.some(buffer => buffer.dirty())) throw Error(t("还有未保存输入，请先保存或处理恢复副本"));
        await action();
    }).finally(() => { pending = false; unregister(); });
    const unregister = registerBuffer('pending-action:' + crypto.randomUUID(), { dirty: () => pending, flush: () => promise });
    editingChanged();
    return promise;
}
export async function flushEditing() {
    for(const buffer of buffers.values()) if(buffer.dirty()) await buffer.flush();
    if(hasPendingInput()) throw Error(t("还有未保存输入，请先保存或处理恢复副本"));
}
export function locked() { return !!getSnapshot()?.control || !getSnapshot()?.actor.scopes.includes('workspace.write'); }
let historyQueue = Promise.resolve();
export function stepHistory(direction: 'undo'|'redo', scope?: string, groupId?: string) {
    historyQueue=historyQueue.then(async()=>{
    if(locked()) { notify(t("请先等待 Agent 完成，或收回控制权"),true); return; }
    try { await flushEditing(); await api('/workspace/history-step',{requestId:crypto.randomUUID(),direction,scope:scope==='workspace'?undefined:scope,groupId}); await reload(); notify(direction==='undo'?'已撤销':'已重做'); }
    catch(error:any) { notify(error.message,true); }
    });
    return historyQueue;
}
