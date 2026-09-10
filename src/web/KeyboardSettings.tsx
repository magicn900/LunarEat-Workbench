import { useState } from 'react';
import { useAccount } from './accountContext';
import { shortcutDefinitions, shortcutKeys, displayShortcut, shortcutFromEvent, shortcutIssues, type ShortcutId, type ShortcutOverrides } from '../shared/shortcuts';
import { t } from './i18n';
import './keyboard-settings.css';

export function KeyboardSettings() {
    const account = useAccount();
    const [recording, setRecording] = useState<ShortcutId | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
    const overrides = account.preferences.shortcuts || {};
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const scopes = { global: t('全局'), workspace: t('工作区'), editor: t('正文编辑'), object: t('对象操作') };
    const save = async (next: ShortcutOverrides) => {
        const issues = shortcutIssues(next);
        if (issues.length) { setError(issues.join('；')); return; }
        setBusy(true); setError('');
        try { await account.savePreferences({ ...account.preferences, shortcuts: next }); setRecording(null); }
        catch (failure: any) { setError(failure.message); }
        finally { setBusy(false); }
    };
    return <div className="keyboard-settings">
        <h2>{t('快捷键')}</h2>
        <p className="settings-description">{t('随账号保存并自动生效。点击修改后按下组合键；Esc 取消。冲突的绑定不会保存。')}</p>
        <p className="settings-description">{t('文字输入框保留原生撤销与复制粘贴，中文组合输入期间不触发快捷键。Tab、方向键和 Esc 保留用于界面操作。')}</p>
        {error && <p role="alert" className="account-error">{error}</p>}
        <button disabled={busy} onClick={() => { if (confirm(t('恢复全部默认快捷键？'))) void save({}); }}>{t('恢复全部默认')}</button>
        <div className="keyboard-bindings">{shortcutDefinitions.map(item => <div className="keyboard-binding" key={item.id}>
            <div><strong>{t(item.label)}</strong><small>{scopes[item.scope]}</small></div>
            <div>{recording === item.id ? <input key={item.id} autoFocus readOnly disabled={busy} data-shortcut-capture aria-label={t('录入快捷键') + '：' + t(item.label)} placeholder={t('按下组合键，Esc 取消')} onKeyDown={event => {
                if (event.nativeEvent.isComposing || event.keyCode === 229 || event.getModifierState('AltGraph')) return;
                if (event.key === 'Tab') { setRecording(null); return; }
                event.preventDefault(); event.stopPropagation();
                if (event.key === 'Escape') { setRecording(null); setError(''); return; }
                if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key) || event.repeat) return;
                const binding = shortcutFromEvent(event.nativeEvent);
                if (!binding) { setError(t('请使用 Ctrl / Cmd 组合键或支持的功能键')); return; }
                void save({ ...overrides, [item.id]: binding });
            }}/> : <kbd>{shortcutKeys(item.id, overrides).map(key => displayShortcut(key, mac)).join(' / ') || t('未绑定')}</kbd>}</div>
            <div className="keyboard-binding-actions">
                <button disabled={busy} aria-label={t('修改快捷键') + '：' + t(item.label)} onClick={() => { setError(''); setRecording(item.id); }}>{t('修改')}</button>
                <button disabled={busy || !shortcutKeys(item.id, overrides).length} aria-label={t('清除快捷键') + '：' + t(item.label)} onClick={() => void save({ ...overrides, [item.id]: null })}>{t('清除')}</button>
                <button disabled={busy || !Object.hasOwn(overrides, item.id)} aria-label={t('恢复快捷键') + '：' + t(item.label)} onClick={() => { const next = { ...overrides }; delete next[item.id]; void save(next); }}>{t('默认')}</button>
            </div>
        </div>)}</div>
        <p role="status" className="settings-description">{busy ? t('正在保存…') : t('更改后自动保存')}</p>
    </div>;
}
