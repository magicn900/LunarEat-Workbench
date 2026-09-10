import { randomUUID } from './uuid';
import { useSyncExternalStore } from 'react';
import { t } from './i18n';
import type { Tree, Entity } from '../shared/model';
export type Snapshot = {
    project: {
        id: string;
        name: string;
        archived?: number;
    };
    tree: Tree;
    workspace: {
        id: string;
        base: string;
        head: string;
        version: number;
    };
    control: { id: string; status: 'pending'|'active'; title: string; expires: number } | null;
    main: string;
    seq: number;
    cursor?: string;
    diagnostics: string[];
    actor: {
        userId: string;
        username: string;
        canSync: boolean;
        administrator?: boolean;
        scopes: string[];
    };
};
let snapshot: Snapshot | null = null;
let pageProject = typeof sessionStorage === 'undefined' ? '' : sessionStorage.getItem('workbench-project') || localStorage.getItem('workbench-project') || '';
export const currentProject = () => pageProject;
export function selectProject(id: string) {
    if (pageProject !== id) { pageProject = id; clearSnapshot(); }
    if (id) { sessionStorage.setItem('workbench-project', id); localStorage.setItem('workbench-project', id); }
    else sessionStorage.removeItem('workbench-project');
}
const listeners = new Set<() => void>();
export const getSnapshot = () => snapshot;
export const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useSnapshot = () => useSyncExternalStore(subscribe, getSnapshot);
export async function api(path: string, body?: unknown, projectId?: string): Promise<any> {
    const response = await fetch('/api' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-workbench-client': 'web', ...((projectId || pageProject) ? { 'x-project-id': projectId || pageProject } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok)
throw Object.assign(new Error(t(result.error) + (result.requestId ? ' [' + result.requestId + ']' : '')), { status: response.status, details: result.details, code: result.code, requestId: result.requestId });
    if (path === '/logout') window.dispatchEvent(new Event('identity-changed'));
    return result;
}
let loading: Promise<void> | null = null;
let reloadAgain = false;
let identityGeneration = 0;
export async function reload() {
    if (loading) { reloadAgain = true; return loading; }
    loading = (async () => {
        do {
            reloadAgain = false;
            const generation = identityGeneration;
            const base = snapshot;
            const next = await api('/workspace' + (base?.cursor ? '?since=' + encodeURIComponent(base.cursor) : ''));
            if (generation === identityGeneration) {
                if (next.delta && base) {
                    const tree = { ...base.tree, ...next.tree };
                    for (const id of next.removed) delete tree[id];
                    snapshot = { ...next, tree };
                } else snapshot = next;
                listeners.forEach(listener => listener());
            }
        } while (reloadAgain);
    })().finally(() => { loading = null; });
    return loading;
}
export function clearSnapshot() { identityGeneration++; snapshot = null; listeners.forEach(listener => listener()); }
export async function apply(operations: unknown[], groupId?: string) { const requestId = randomUUID(); const result = await api('/workspace/operations', { requestId, groupId: groupId || requestId, operations }); await reload(); return result; }
export const put = (entity: Entity, expected: Entity | null) => apply([{ type: 'put', entity, expected }]);
export function notify(message: string, error = false) { window.dispatchEvent(new CustomEvent('notice', { detail: { message: t(message), error } })); }
export function navigate(id: string) { window.dispatchEvent(new CustomEvent('open-entity', { detail: id })); }
