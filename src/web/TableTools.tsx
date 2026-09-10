import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlignLeft, AlignCenter, AlignRight, Trash2 } from 'lucide-react';
import { t } from './i18n';
import { locked } from './editing';
import { tableCommand, tableContext } from './tableCommands';
import { TableEdges } from './TableEdges';
import type { EditorToolsController } from './editorCommands';
import type { EditorState } from '@milkdown/prose/state';

const rowActions = [['row-before', '在上方插入行'], ['row-after', '在下方插入行'], ['row-up', '上移此行'], ['row-down', '下移此行'], ['row-delete', '删除此行'], ['table-delete', '删除整张表格']];
const columnActions = [['column-before', '在左侧插入列'], ['column-after', '在右侧插入列'], ['column-left', '左移此列'], ['column-right', '右移此列'], ['column-delete', '删除此列'], ['align-left', '列左对齐'], ['align-center', '列居中'], ['align-right', '列右对齐'], ['table-delete', '删除整张表格']];

export function TableTools({ controller, editor }: { controller: EditorToolsController; editor: EditorState | null }) {
    const context = editor && tableContext(editor);
    const [keyboard, setKeyboard] = useState(false);
    const [coarse, setCoarse] = useState(() => window.matchMedia('(hover: none)').matches);
    const [menu, setMenu] = useState<{ kind: 'row' | 'column'; left: number; top: number } | null>(null);
    useEffect(() => {
        const media = window.matchMedia('(hover: none)');
        const changed = () => setCoarse(media.matches);
        const key = (event: KeyboardEvent) => { if (event.key === 'Tab' || event.key.startsWith('Arrow') && controller.editorElement()?.contains(event.target as Node)) setKeyboard(true); };
        const pointer = (event: PointerEvent) => { if (event.pointerType === 'mouse' && !(event.target as Element).closest('.markdown-table-toolbar')) setKeyboard(false); };
        media.addEventListener('change', changed); window.addEventListener('keydown', key); window.addEventListener('pointerdown', pointer);
        return () => { media.removeEventListener('change', changed); window.removeEventListener('keydown', key); window.removeEventListener('pointerdown', pointer); };
    }, [controller]);
    useEffect(() => {
        if (!menu) return;
        const outside = (event: PointerEvent) => { if (!(event.target as Element).closest('.markdown-table-menu,.markdown-table-controls')) setMenu(null); };
        const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMenu(null); controller.focus(); } };
        window.addEventListener('pointerdown', outside); window.addEventListener('keydown', escape);
        document.querySelector<HTMLButtonElement>('.markdown-table-menu button:not(:disabled)')?.focus();
        return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape); };
    }, [menu, controller]);
    useEffect(() => { if (!context) setMenu(null); }, [!!context]);
    const disabled = locked();
    const run = (id: string) => {
        if (id === 'table-delete' && !confirm(t('删除整张 Markdown 表格？此操作可以撤销。'))) return;
        setMenu(null); controller.runTable(id);
    };
    const open = (kind: 'row' | 'column', element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        setMenu({ kind, left: Math.max(8, Math.min(rect.left, window.innerWidth - 212)), top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - (kind === 'row' ? 270 : 390))) });
    };
    return <>
        {context && (keyboard || coarse) && <div className="markdown-table-toolbar markdown-table-controls" role="toolbar" aria-label={t('Markdown 表格编辑')}>
            <span>{t('表格')} · {context.row === 0 ? t('表头') : context.row + 1} / {context.rows} × {context.columns}</span>
            <button disabled={disabled} aria-haspopup="menu" onMouseDown={event => event.preventDefault()} onClick={event => open('row', event.currentTarget)}>{t('行操作')}</button>
            <button disabled={disabled} aria-haspopup="menu" onMouseDown={event => event.preventDefault()} onClick={event => open('column', event.currentTarget)}>{t('列操作')}</button>
            <span className="toolbar-divider"/>
            {([['left', AlignLeft, '列左对齐'], ['center', AlignCenter, '列居中'], ['right', AlignRight, '列右对齐']] as const).map(([alignment, Icon, label]) => <button key={alignment} disabled={disabled} aria-label={t(label)} title={t(label)} aria-pressed={context.table.firstChild?.child(context.column).attrs.alignment === alignment} onMouseDown={event => event.preventDefault()} onClick={() => run('align-' + alignment)}><Icon size={15}/></button>)}
            <button disabled={disabled} aria-label={t('删除整张表格')} title={t('删除整张表格')} onMouseDown={event => event.preventDefault()} onClick={() => run('table-delete')}><Trash2 size={15}/></button>
            <small>{t('Tab 切换单元格 · 末格 Tab 新增行')}</small>
        </div>}
        <TableEdges controller={controller} menuOpen={!!menu} onMenu={open}/>
        {menu && context && editor && createPortal(<div className="markdown-table-menu" role="menu" aria-label={t(menu.kind === 'row' ? '行操作' : '列操作')} style={{ left: menu.left, top: menu.top }} onKeyDown={event => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }}>{(menu.kind === 'row' ? rowActions : columnActions).map(([id, label]) => <button key={id} role="menuitem" disabled={disabled || !tableCommand(id)(editor)} onMouseDown={event => event.preventDefault()} onClick={() => run(id)}>{t(label)}</button>)}</div>, document.body)}
    </>;
}
