import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { randomUUID } from './uuid';
import { flushEditing } from './editing';
import { getSnapshot, notify, type Snapshot } from './state';
import { captureReadingPosition, restoreReadingPosition, type ReadingPosition } from './readingPosition';

type Route = { tab: string; selected: string; selectedCollection: string };
type Entry = { route: Route; position: ReadingPosition };
type Journal = { entries: Entry[]; index: number; session: string; positions: Record<string, ReadingPosition> };
const initialRoute: Route = { tab: 'workspace', selected: 'overview', selectedCollection: '' };
const routeKey = (route: Route) => route.tab === 'workspace' || route.tab === 'collections' ? JSON.stringify(route) : route.tab;

export function useReadingNavigation(snapshot: Snapshot | null, ready: boolean) {
    const scope = snapshot && ready ? snapshot.actor.userId + ':' + snapshot.project.id + ':' + snapshot.workspace.id : '';
    const [view, setView] = useState({ route: initialRoute, index: 0, length: 1, revision: 0, busy: false });
    const controller = useRef<{ open: (route: Route) => void; travel: (delta: number) => void; save: (index?: number) => void; position: () => ReadingPosition } | null>(null);
    useEffect(() => {
        if (!scope) return;
        const storageKey = 'workbench-reading:v1:' + scope;
        let journal: Journal = { entries: [{ route: initialRoute, position: {} }], index: 0, session: randomUUID(), positions: {} };
        try {
            const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
            if (saved && Array.isArray(saved.entries) && saved.entries.length && Number.isInteger(saved.index) && saved.entries[saved.index] && typeof saved.session === 'string' && saved.entries.every((entry: Entry) => entry.route && typeof entry.route.selected === 'string' && typeof entry.route.selectedCollection === 'string' && ['workspace', 'collections', 'changes', 'schedule', 'inspiration'].includes(entry.route.tab) && entry.position && typeof entry.position === 'object')) journal = saved;
        } catch {}
        journal.positions = journal.positions && typeof journal.positions === 'object' ? journal.positions : {};
        const marker = () => window.history.state?.workbenchReading;
        const existing = marker();
        if (existing?.scope === scope && existing.session === journal.session && journal.entries[existing.index]) journal.index = existing.index;
        else journal = { ...journal, entries: [journal.entries[journal.index]], index: 0, session: randomUUID() };
        let busy = false;
        let disposed = false;
        let revision = 0;
        let generation = 0;
        const persist = () => { try { sessionStorage.setItem(storageKey, JSON.stringify(journal)); } catch {} };
        const publish = () => { if (!disposed) setView({ route: journal.entries[journal.index].route, index: journal.index, length: journal.entries.length, revision: ++revision, busy }); };
        const save = (index = journal.index) => {
            if (index !== journal.index) return;
            const position = captureReadingPosition();
            const entry = journal.entries[journal.index];
            if (Object.keys(position).length) { entry.position = position; journal.positions[routeKey(entry.route)] = position; }
            persist();
        };
        const pagehide = () => save();
        const state = () => ({ ...window.history.state, workbenchReading: { scope, session: journal.session, index: journal.index } });
        window.history.replaceState(state(), '');
        const previousRestoration = window.history.scrollRestoration;
        window.history.scrollRestoration = 'manual';
        persist();
        publish();
        const open = async (route: Route) => {
            if (busy || routeKey(route) === routeKey(journal.entries[journal.index].route)) return;
            busy = true;
            setView(current => ({ ...current, busy: true }));
            let moved = false;
            const request = ++generation;
            try {
                await flushEditing();
                if (disposed || request !== generation) return;
                save();
                const position = journal.positions[routeKey(route)] || {};
                journal.entries = journal.entries.slice(0, journal.index + 1);
                journal.entries.push({ route, position });
                journal.index++;
                window.history.pushState(state(), '');
                moved = true;
                persist();
            } catch (error: any) { notify(error.message, true); }
            finally { if (request === generation) { busy = false; if (moved) publish(); else if (!disposed) setView(current => ({ ...current, busy: false })); } }
        };
        const travel = (delta: number) => {
            if (busy || !journal.entries[journal.index + delta]) return;
            busy = true;
            setView(current => ({ ...current, busy: true }));
            window.history.go(delta);
        };
        const pop = async () => {
            const target = marker();
            if (target?.scope !== scope || target.session !== journal.session || !journal.entries[target.index]) {
                generation++;
                save();
                journal = { ...journal, entries: [journal.entries[journal.index]], index: 0, session: randomUUID() };
                window.history.replaceState(state(), '');
                busy = false;
                persist();
                setView(current => ({ ...current, index: 0, length: 1, busy: false }));
                return;
            }
            if (target.index === journal.index) { generation++; busy = false; setView(current => ({ ...current, busy: false })); return; }
            const request = ++generation;
            busy = true;
            setView(current => ({ ...current, busy: true }));
            try {
                await flushEditing();
                if (disposed || request !== generation) return;
                save();
                journal.index = target.index;
                busy = false;
                persist();
                publish();
            } catch (error: any) {
                if (disposed || request !== generation) return;
                notify(error.message, true);
                window.history.go(journal.index - target.index);
            }
        };
        const entity = (event: Event) => {
            const id = (event as CustomEvent<string>).detail;
            const target = getSnapshot()?.tree[id];
            void open({ selected: id, selectedCollection: target?.kind === 'collection' ? id : target?.kind === 'view' ? target.collection : '', tab: target?.kind === 'collection' || target?.kind === 'view' ? 'collections' : 'workspace' });
        };
        const mouse = (event: MouseEvent) => {
            if (event.button !== 3 && event.button !== 4) return;
            event.preventDefault();
            event.stopPropagation();
            if (event.type === 'mouseup') travel(event.button === 3 ? -1 : 1);
        };
        controller.current = { open: route => { void open(route); }, travel, save, position: () => journal.entries[journal.index].position };
        window.addEventListener('open-entity', entity);
        window.addEventListener('popstate', pop);
        window.addEventListener('pagehide', pagehide);
        for (const name of ['mousedown', 'mouseup', 'auxclick']) window.addEventListener(name, mouse as EventListener, true);
        return () => {
            disposed = true;
            controller.current = null;
            window.history.scrollRestoration = previousRestoration;
            window.removeEventListener('open-entity', entity);
            window.removeEventListener('popstate', pop);
            window.removeEventListener('pagehide', pagehide);
            for (const name of ['mousedown', 'mouseup', 'auxclick']) window.removeEventListener(name, mouse as EventListener, true);
        };
    }, [scope]);
    useLayoutEffect(() => {
        if (!controller.current) return;
        const active = controller.current;
        return restoreReadingPosition(active.position(), () => { if (controller.current === active) active.save(view.index); });
    }, [view.route, view.revision]);
    return { ...view, openTab: (tab: string) => controller.current?.open({ ...view.route, tab }), back: () => controller.current?.travel(-1), forward: () => controller.current?.travel(1) };
}
