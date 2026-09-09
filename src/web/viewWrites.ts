import { t } from './i18n';
import type { CollectionView } from '../shared/model';
import { viewFilters } from '../shared/viewQuery';
import { editingChanged, registerBuffer } from './editing';
import { getSnapshot, notify, put } from './state';
const queues = new Map<string, { promise: Promise<void>; unregister: () => void }>();
export function updateView(viewId: string, patch: Partial<CollectionView>): Promise<void> {
    const user = getSnapshot()?.actor.userId;
    const key = user + ':' + viewId;
    let queue = queues.get(key);
    if (!queue) {
        queue = { promise: Promise.resolve(), unregister: () => {} };
        const tracked = queue;
        queue.unregister = registerBuffer('view-write:' + key, { dirty: () => queues.has(key), flush: () => tracked.promise });
        queues.set(key, queue);
    }
    const tracked = queue;
    const promise = queue.promise.catch(() => {}).then(async () => {
        if (getSnapshot()?.actor.userId !== user) throw Error(t("账号已切换，未继续写入视图"));
        const current = getSnapshot()?.tree[viewId];
        if (current?.kind !== 'view') throw Error(t("视图已删除"));
        await put({ ...current, ...patch, filters: patch.filters ?? viewFilters(current), filter: null, filterLogic: 'and' }, current);
    }).catch(error => { notify(error.message, true); throw error; }).finally(() => {
        if (tracked.promise === promise) { queues.delete(key); tracked.unregister(); }
        editingChanged();
    });
    queue.promise = promise;
    editingChanged();
    return promise;
}
