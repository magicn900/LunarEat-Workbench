import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GripHorizontal, GripVertical, Plus } from 'lucide-react';
import type { EditorToolsController } from './editorCommands';
import { locked } from './editing';
import { t } from './i18n';

type Target = { kind: 'row' | 'column' | 'append-row' | 'append-column'; cell: HTMLTableCellElement; left: number; top: number; row: number; column: number };
export function TableEdges({ controller, menuOpen, onMenu }: { controller: EditorToolsController; menuOpen: boolean; onMenu: (kind: 'row' | 'column', element: HTMLElement) => void }) {
    const [target, setTarget] = useState<Target | null>(null);
    const last = useRef<{ x: number; y: number } | null>(null);
    useEffect(() => {
        let frame = 0;
        let hiding: ReturnType<typeof setTimeout> | undefined;
        const hide = () => { clearTimeout(hiding); hiding = setTimeout(() => setTarget(null), 100); };
        const measure = () => {
            if (menuOpen || !last.current) return;
            const root = controller.editorElement();
            const clip = root?.closest('.document-scroll')?.getBoundingClientRect();
            const { x, y } = last.current;
            if (!root || !clip || x < clip.left || x > clip.right || y < clip.top || y > clip.bottom) { hide(); return; }
            for (const table of root.querySelectorAll<HTMLTableElement>('table')) {
                if (table.closest('.collection-grid,.document-embed')) continue;
                const bounds = table.getBoundingClientRect();
                if (x < bounds.left - 25 || x > bounds.right + 25 || y < bounds.top - 25 || y > bounds.bottom + 25) continue;
                const rows = [...table.rows];
                const row = Math.max(0, rows.findIndex(item => { const rect = item.getBoundingClientRect(); return y >= rect.top && y <= rect.bottom; }));
                const headers = [...(rows[0]?.cells || [])];
                const column = Math.max(0, headers.findIndex(item => { const rect = item.getBoundingClientRect(); return x >= rect.left && x <= rect.right; }));
                const cell = rows[row]?.cells[column];
                if (!cell) continue;
                const rect = cell.getBoundingClientRect();
                let next: Target | null = null;
                if (y >= bounds.bottom - 7 && x >= bounds.left && x <= bounds.right) next = { kind: 'append-row', cell, left: rect.left + rect.width / 2 - 11, top: bounds.bottom + 2, row, column };
                else if (x >= bounds.right - 7 && y >= bounds.top && y <= bounds.bottom) next = { kind: 'append-column', cell, left: bounds.right + 2, top: rect.top + rect.height / 2 - 11, row, column };
                else if (y <= bounds.top + 7 && x >= bounds.left && x <= bounds.right) next = { kind: 'column', cell, left: rect.left + rect.width / 2 - 11, top: bounds.top - 23, row, column };
                else if (x <= bounds.left + 7 && y >= bounds.top && y <= bounds.bottom) next = { kind: 'row', cell, left: bounds.left - 23, top: rect.top + rect.height / 2 - 11, row, column };
                if (next && next.left >= clip.left && next.left + 22 <= clip.right && next.top >= clip.top && next.top + 22 <= clip.bottom) { clearTimeout(hiding); setTarget(next); return; }
            }
            hide();
        };
        const move = (event: PointerEvent) => {
            if (event.pointerType === 'touch') return;
            if ((event.target as Element).closest('.markdown-table-edges,.markdown-table-menu')) { clearTimeout(hiding); return; }
            last.current = { x: event.clientX, y: event.clientY };
            cancelAnimationFrame(frame); frame = requestAnimationFrame(measure);
        };
        const changed = () => { if (!menuOpen) { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); } };
        const leave = () => { if (!menuOpen) hide(); };
        window.addEventListener('pointermove', move);
        window.addEventListener('scroll', changed, true);
        window.addEventListener('resize', changed);
        document.documentElement.addEventListener('pointerleave', leave);
        if (!menuOpen) measure();
        return () => { clearTimeout(hiding); cancelAnimationFrame(frame); window.removeEventListener('pointermove', move); window.removeEventListener('scroll', changed, true); window.removeEventListener('resize', changed); document.documentElement.removeEventListener('pointerleave', leave); };
    }, [controller, menuOpen]);
    if (!target || locked()) return null;
    const label = target.kind === 'row' ? t('当前行操作') : target.kind === 'column' ? t('当前列操作') : target.kind === 'append-row' ? t('在表格末尾添加行') : t('在表格右侧添加列');
    const Icon = target.kind === 'row' ? GripVertical : target.kind === 'column' ? GripHorizontal : Plus;
    return createPortal(<div className="markdown-table-controls markdown-table-edges"><button data-edge={target.kind} data-row={target.row} data-column={target.column} style={{ top: target.top, left: target.left }} aria-label={label} title={label} aria-haspopup={target.kind === 'row' || target.kind === 'column' ? 'menu' : undefined} onMouseDown={event => event.preventDefault()} onClick={event => {
        if (!target.cell.isConnected || !controller.selectTableCell(target.cell)) { setTarget(null); return; }
        if (target.kind === 'row' || target.kind === 'column') onMenu(target.kind, event.currentTarget);
        else { controller.runTable(target.kind === 'append-row' ? 'row-append' : 'column-append'); setTarget(null); }
    }}><Icon size={15}/></button></div>, document.body);
}
