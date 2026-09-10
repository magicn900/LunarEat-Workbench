import { expect, it } from 'vitest';
import { canonicalShortcut, shortcutIssues, shortcutKeys, shortcutMatches, shortcutFromEvent, type ShortcutEvent } from '../src/shared/shortcuts';
const event = (changes: Partial<ShortcutEvent> = {}): ShortcutEvent => ({ key: 'b', code: 'KeyB', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 66, ...changes });
it('默认快捷键无冲突，清除与恢复不产生第二套绑定', () => {
    expect(shortcutIssues({})).toEqual([]);
    expect(shortcutKeys('redo', {})).toEqual(['Mod+Shift+Z', 'Mod+Y']);
    expect(shortcutKeys('redo', { redo: null })).toEqual([]);
    expect(shortcutMatches('bold', event(), { bold: 'Mod+Shift+B' })).toBe(false);
    expect(shortcutMatches('bold', event({ shiftKey: true }), { bold: 'Mod+Shift+B' })).toBe(true);
});
it('校验作用域冲突、未知操作、浏览器保留键及普通文字输入', () => {
    expect(shortcutIssues({ highlight: 'Mod+B' }).join()).toContain('冲突');
    expect(shortcutIssues({ rename: 'Mod+B' })).toEqual([]);
    expect(shortcutIssues({ palette: 'Mod+B' }).join()).toContain('冲突');
    for (const key of ['Mod+W', 'Mod+Shift+I', 'Mod+Shift+J', 'Mod+Shift+C']) expect(shortcutIssues({ highlight: key }).join()).toContain('保留');
    expect(shortcutIssues({ save: 'Delete' }).join()).toContain('删除键');
    expect(canonicalShortcut('B')).toBeNull();
    expect(canonicalShortcut('Mod+Mod+B')).toBeNull();
    expect(shortcutIssues({ unknown: null } as any).join()).toContain('未知');
});
it('匹配精确修饰键，兼容 Cmd，并保护中文组合输入', () => {
    expect(shortcutMatches('bold', event({ metaKey: true, ctrlKey: false }), {})).toBe(true);
    expect(shortcutMatches('bold', event({ altKey: true }), {})).toBe(false);
    expect(shortcutFromEvent(event({ isComposing: true }))).toBeNull();
    expect(shortcutFromEvent(event({ keyCode: 229 }))).toBeNull();
    expect(shortcutFromEvent(event({ metaKey: true }))).toBeNull();
});
