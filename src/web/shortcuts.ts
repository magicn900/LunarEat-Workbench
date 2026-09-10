import { useSyncExternalStore } from 'react';
import { displayShortcut, shortcutKeys, shortcutMatches, type ShortcutId, type ShortcutOverrides, type ShortcutEvent } from '../shared/shortcuts';
let overrides: ShortcutOverrides = {};
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getShortcuts = () => overrides;
export const useShortcuts = () => useSyncExternalStore(subscribe, getShortcuts);
export function setShortcuts(next: ShortcutOverrides) {
    if (JSON.stringify(next) === JSON.stringify(overrides)) return;
    overrides = { ...next }; listeners.forEach(listener => listener());
}
export const matchesShortcut = (id: ShortcutId, event: ShortcutEvent) => shortcutMatches(id, event, overrides);
export const shortcutLabel = (id: ShortcutId) => shortcutKeys(id, overrides).map(key => displayShortcut(key, /Mac|iPhone|iPad/.test(navigator.platform))).join(' / ');
