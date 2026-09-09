import { useSyncExternalStore } from 'react';
import { english } from './locales/en';
export type Language = 'zh-CN' | 'en';
let language: Language = 'zh-CN';
const listeners = new Set<() => void>();
export function setLanguage(next: Language) {
    if (next === language) return;
    language = next;
    document.documentElement.lang = next;
    listeners.forEach(listener => listener());
}
export function useLanguage() { return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => language); }
export function t(source: string): string { return language === 'en' ? english[source] ?? source : source; }
