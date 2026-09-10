export const shortcutDefinitions = [
    { id: 'palette', label: '命令与页面搜索', scope: 'global', keys: ['Mod+K'] },
    { id: 'save', label: '保存当前编辑', scope: 'global', keys: ['Mod+S'] },
    { id: 'search', label: '搜索工作区', scope: 'global', keys: ['Mod+Shift+F'] },
    { id: 'find', label: '正文查找', scope: 'editor', keys: ['Mod+F'] },
    { id: 'undo', label: '撤销', scope: 'workspace', keys: ['Mod+Z'] },
    { id: 'redo', label: '重做', scope: 'workspace', keys: ['Mod+Shift+Z', 'Mod+Y'] },
    { id: 'bold', label: '加粗', scope: 'editor', keys: ['Mod+B'] },
    { id: 'italic', label: '斜体', scope: 'editor', keys: ['Mod+I'] },
    { id: 'highlight', label: '高亮', scope: 'editor', keys: [] },
    { id: 'strikethrough', label: '删除线', scope: 'editor', keys: ['Mod+Alt+X'] },
    { id: 'link', label: '插入链接', scope: 'editor', keys: ['Mod+Shift+K'] },
    { id: 'table', label: '插入表格', scope: 'editor', keys: [] },
    { id: 'math-inline', label: '行内公式', scope: 'editor', keys: [] },
    { id: 'math-block', label: '独立公式', scope: 'editor', keys: [] },
    { id: 'image', label: '插入图片', scope: 'editor', keys: [] },
    { id: 'rename', label: '重命名', scope: 'object', keys: ['F2'] },
    { id: 'delete', label: '删除聚焦对象', scope: 'object', keys: ['Delete'] },
    { id: 'context-menu', label: '打开聚焦对象的菜单', scope: 'object', keys: ['Shift+F10'] }
] as const;
export type ShortcutId = typeof shortcutDefinitions[number]['id'];
export type ShortcutScope = typeof shortcutDefinitions[number]['scope'];
export type ShortcutOverrides = Partial<Record<ShortcutId, string | null>>;
export function shortcutKeys(id: ShortcutId, overrides: ShortcutOverrides): readonly string[] {
    const override = overrides[id];
    return override === null ? [] : override === undefined ? shortcutDefinitions.find(item => item.id === id)!.keys : [override];
}
export function canonicalShortcut(value: string): string | null {
    const parts = value.split('+'), key = parts.pop() || '';
    if (parts.some(part => !['Mod', 'Alt', 'Shift'].includes(part)) || new Set(parts).size !== parts.length) return null;
    if (!/^(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|Delete)$/.test(key)) return null;
    if (/^[A-Z0-9]$/.test(key) && !parts.includes('Mod')) return null;
    return [...['Mod', 'Alt', 'Shift'].filter(part => parts.includes(part)), key].join('+');
}
export function shortcutIssues(overrides: ShortcutOverrides): string[] {
    const issues: string[] = [];
    for (const [id, value] of Object.entries(overrides)) {
        if (!shortcutDefinitions.some(item => item.id === id)) { issues.push('未知快捷键操作：' + id); continue; }
        if (value === null) continue;
        if (typeof value !== 'string' || canonicalShortcut(value) !== value) { issues.push('快捷键格式不合法：' + id); continue; }
        if (value.endsWith('Delete') && (shortcutDefinitions.find(item => item.id === id)!.scope !== 'object' || value !== 'Delete')) issues.push('删除键保留用于文字或对象删除');
        if (['Mod+C', 'Mod+V', 'Mod+X', 'Mod+A', 'Mod+L', 'Mod+R', 'Mod+W', 'Mod+T', 'Mod+N', 'Mod+Q', 'Mod+O', 'Mod+P', 'Mod+J', 'Mod+H', 'Mod+Shift+I', 'Mod+Shift+J', 'Mod+Shift+C', 'Mod+Shift+R', 'Mod+Shift+T', 'Mod+Shift+N', 'Mod+Shift+W', 'Alt+F4', 'Mod+Alt+Delete', 'F1', 'F5', 'F11', 'F12'].includes(value)) issues.push('该组合键保留给浏览器或系统：' + value);
    }
    for (const [index, left] of shortcutDefinitions.entries()) for (const right of shortcutDefinitions.slice(index + 1)) {
        if ((left.scope === 'object' && right.scope === 'editor') || (left.scope === 'editor' && right.scope === 'object')) continue;
        const conflict = shortcutKeys(left.id, overrides).find(key => shortcutKeys(right.id, overrides).includes(key));
        if (conflict) issues.push('快捷键冲突：' + left.label + ' / ' + right.label + ' (' + conflict + ')');
    }
    return issues;
}
export type ShortcutEvent = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'keyCode'>;
export function shortcutFromEvent(event: ShortcutEvent): string | null {
    if (event.isComposing || event.keyCode === 229 || (event.ctrlKey && event.metaKey)) return null;
    let key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
    if (!/^[A-Z0-9]$/.test(key) && /^Key[A-Z]$/.test(event.code)) key = event.code.slice(3);
    return canonicalShortcut([...(event.ctrlKey || event.metaKey ? ['Mod'] : []), ...(event.altKey ? ['Alt'] : []), ...(event.shiftKey ? ['Shift'] : []), key].join('+'));
}
export function shortcutMatches(id: ShortcutId, event: ShortcutEvent, overrides: ShortcutOverrides): boolean {
    const key = shortcutFromEvent(event);
    return !!key && shortcutKeys(id, overrides).includes(key);
}
export function displayShortcut(key: string, mac = false) { return key.replace('Mod', mac ? 'Cmd' : 'Ctrl'); }
