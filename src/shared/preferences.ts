import type { ShortcutOverrides } from './shortcuts.js';
export type Preferences = { theme: 'light' | 'dark' | 'system'; language: 'zh-CN' | 'en'; version: number; shortcuts?: ShortcutOverrides };
export const defaultPreferences: Preferences = { theme: 'system', language: 'zh-CN', version: 0, shortcuts: {} };
