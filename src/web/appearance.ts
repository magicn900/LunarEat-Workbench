import type { Preferences } from '../shared/preferences';
import { setLanguage } from './i18n';
let theme: Preferences['theme'] = 'system';
const system = window.matchMedia('(prefers-color-scheme: dark)');
const render = () => { document.documentElement.dataset.theme = theme === 'system' ? system.matches ? 'dark' : 'light' : theme; };
system.addEventListener('change', render);
export function applyAppearance(preferences: Preferences) {
    theme = preferences.theme;
    render();
    setLanguage(preferences.language);
    try { localStorage.setItem('workbench-appearance', JSON.stringify({ theme, language: preferences.language })); } catch {}
}
try {
    const saved = JSON.parse(localStorage.getItem('workbench-appearance') || '{}');
    if (['light', 'dark', 'system'].includes(saved.theme)) theme = saved.theme;
    if (saved.language === 'en') setLanguage('en');
} catch {}
render();

