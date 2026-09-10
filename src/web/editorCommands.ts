import { insertMath } from './mathEditing';
import { t } from './i18n';
import { ImageController } from './ImageController';
import { insertMarkdownTable, tableCommand, tableContext } from './tableCommands';
import { Plugin, TextSelection, NodeSelection, type EditorState } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import { toggleMark, setBlockType, wrapIn } from '@milkdown/prose/commands';
import { wrapInList } from '@milkdown/prose/schema-list';
import { Fragment } from '@milkdown/prose/model';
import { normalizeEmbeds, type EmbedTarget } from '../shared/embeds';
import { locked, stepHistory } from './editing';
import { getSnapshot, notify } from './state';
import { editorCommands } from './editorCommandRegistry';
import { matchesShortcut } from './shortcuts';
export type Picker = { kind: 'link'|'view'|'doc'|'source'; from: number; to: number; initial: string; label: string; invalid?: boolean };
export type ToolsState = { editor: EditorState|null; picker: Picker|null; slash: { from: number; to: number; query: string; index: number }|null };
export class EditorToolsController {
    private listeners = new Set<() => void>();
    private state: ToolsState = { editor: null, picker: null, slash: null };
    private dismissed = '';
    private view: EditorView|null = null;
    onCommand = () => {};
    readonly images: ImageController;
    constructor(readonly documentId: string) { this.images = new ImageController(documentId, () => this.onCommand()); }
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
    snapshot = () => this.state;
    private emit(patch: Partial<ToolsState>) { this.state = { ...this.state, ...patch }; if (this.view) { const command = this.state.slash ? this.slashItems()[this.state.slash.index] : null; if (command) { this.view.dom.setAttribute('aria-controls', 'slash-commands'); this.view.dom.setAttribute('aria-activedescendant', 'slash-command-' + command.id); } else { this.view.dom.removeAttribute('aria-controls'); this.view.dom.removeAttribute('aria-activedescendant'); } } this.listeners.forEach(listener => listener()); }
    private refresh(view: EditorView) {
        this.view = view;
        const selection = view.state.selection;
        const before = selection.$from.parent.textBetween(0, selection.$from.parentOffset, '', '');
        const match = selection.empty && selection.$from.parent.type.name === 'paragraph' && !view.composing && before.length <= 60 ? /^\/([^/]*)$/.exec(before) : null;
        const slash = match && !locked() && !this.state.picker && this.dismissed !== selection.from + ':' + before ? { from: selection.$from.start(), to: selection.from, query: match[1], index: this.state.slash?.query === match[1] ? this.state.slash.index : 0 } : null;
        this.emit({ editor: view.state, slash });
    }
    plugin = new Plugin({
        state: { init: () => null, apply: transaction => {
            const picker = this.state.picker;
            if (picker && transaction.docChanged) {
                const from = transaction.mapping.mapResult(picker.from, 1), to = transaction.mapping.mapResult(picker.to, -1);
                this.state = { ...this.state, picker: { ...picker, from: from.pos, to: Math.max(from.pos, to.pos), invalid: picker.invalid || from.deletedAcross || to.deletedAcross } };
            }
            return null;
        } },
        appendTransaction: (transactions, _old, current) => {
            if (!transactions.some(transaction => transaction.docChanged)) return null;
            const normalized = normalizeEmbeds(current.doc);
            if (!normalized.steps.length) return null;
            const transaction = current.tr;
            normalized.steps.forEach(step => transaction.step(step));
            return transaction;
        },
        props: { attributes: () => ({ role: 'textbox', 'aria-label': t('正文编辑区'), 'aria-multiline': 'true' }), handleDOMEvents: { compositionend: view => { setTimeout(() => { if (this.view === view) this.refresh(view); }, 0); return false; } }, handleKeyDown: (view, event) => {
            if (event.isComposing || view.composing || event.keyCode === 229 || event.getModifierState('AltGraph')) return false;
            if (event.key === 'Tab' && tableContext(view.state) && !locked()) { this.runTable(event.shiftKey ? 'cell-previous' : 'cell-next'); return true; }
            for (const id of ['bold', 'italic', 'highlight', 'strikethrough', 'link', 'table', 'image', 'math-inline', 'math-block'] as const) {
                if (matchesShortcut(id, event)) { this.run(id); return true; }
            }
            if (!this.state.slash) return false;
            if (event.key === 'Escape') { this.close(); return true; }
            const items = this.slashItems();
            if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) { const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (this.state.slash.index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; this.emit({ slash: { ...this.state.slash, index: Math.max(0, index) } }); return true; }
            if (event.key === 'Enter' && items[this.state.slash.index]) { this.run(items[this.state.slash.index].id); return true; }
            return false;
        } },
        view: view => { this.refresh(view); return { update: next => this.refresh(next), destroy: () => { this.view = null; this.emit({ editor: null, picker: null, slash: null }); } }; }
    });
    slashItems() { const query = this.state.slash?.query.toLocaleLowerCase() || ''; return editorCommands.filter(command => (t(command.title) + ' ' + command.words).toLocaleLowerCase().includes(query)); }
    close = () => { const slash = this.state.slash; if (slash) this.dismissed = slash.to + ':/' + slash.query; this.emit({ picker: null, slash: null }); this.view?.focus(); };
    focus = () => this.view?.focus();
    editorElement = () => this.view?.dom || null;
    selectTableCell = (cell: HTMLElement) => {
        if (!this.view || !this.view.dom.contains(cell) || !this.writable()) return false;
        const position = this.view.posAtDOM(cell, 0);
        this.view.dispatch(this.view.state.tr.setSelection(TextSelection.near(this.view.state.doc.resolve(position))));
        return true;
    };
    tableElements = () => {
        if (!this.view) return null;
        const context = tableContext(this.view.state);
        if (!context) return null;
        const element = this.view.nodeDOM(context.tableStart - 1) as HTMLElement | null;
        const table = element?.matches('table') ? element : element?.querySelector('table');
        const cellPosition = context.tableStart + context.map.positionAt(context.row, context.column, context.table);
        const cell = this.view.nodeDOM(cellPosition) as HTMLElement | null;
        return table && cell ? { table, cell } : null;
    };
    runTable = (id: string) => {
        if (!this.writable()) return;
        const view = this.view!;
        tableCommand(id)(view.state, transaction => { this.onCommand(); view.dispatch(transaction.scrollIntoView()); }, view);
        view.focus();
    };
    caret = () => { try { return this.view?.coordsAtPos(this.view.state.selection.from) || null; } catch { return null; } };
    private writable() { if (!this.view || locked() || !this.view.editable || this.view.composing) { notify(t("当前不能编辑，请等待输入结束或收回控制权"), true); return false; } return true; }
    openPicker(kind: Picker['kind'], range?: { from: number; to: number }, initial = '') {
        if (!this.writable()) return;
        const state = this.view!.state;
        const selected = range || this.state.slash || state.selection;
        let from = selected.from, to = selected.to;
        let label = state.doc.textBetween(from, to, ' ');
        if (kind === 'link' && !this.state.slash && !range) {
            const mark = state.selection.$from.marks().find(mark => mark.type.name === 'link');
            if (mark) {
                state.selection.$from.parent.forEach((node, offset) => { if (node.marks.some(candidate => candidate.eq(mark))) { const start = state.selection.$from.start() + offset; if (start <= from && start + node.nodeSize >= to) { from = start; to = start + node.nodeSize; } } });
                initial = mark.attrs.href; label = state.doc.textBetween(from, to, ' ');
            }
        }
        this.emit({ picker: { kind, from, to, initial, label: this.state.slash || kind !== 'link' ? '' : label }, slash: null });
    }
    insert(target: string, label = '') {
        if (!this.writable()) return;
        const picker = this.state.picker;
        if (!picker || picker.invalid) { notify(t("插入位置已被其他修改移除，请重新选择位置"), true); return; }
        if (picker.kind === 'source') { const match = /^:::(view|doc)\[([a-zA-Z0-9_-]+)\]$/.exec(target.trim()); if (!match) { notify(t("请输入有效的嵌入语法"), true); return; } this.insertEmbed({ kind: match[1] as EmbedTarget['kind'], target: match[2] }, picker); return; }
        const entity = getSnapshot()?.tree[target];
        if (picker.kind === 'link') {
            const href = entity ? 'doc:' + entity.id : target;
            if (!entity && !/^(https?:\/\/|mailto:)/i.test(href)) { notify(t("请选择工作区对象，或输入 https / http / mailto 链接"), true); return; }
            const view = this.view!;
            this.onCommand();
            this.emit({ picker: null });
            view.dispatch(view.state.tr.replaceWith(picker.from, picker.to, view.state.schema.text(label || entity?.title || href, [view.state.schema.marks.link.create({ href })])).scrollIntoView());
            view.focus(); return;
        }
        if (!entity || picker.kind === 'view' && entity.kind !== 'view' || picker.kind === 'doc' && entity.kind !== 'object') { notify(t("目标已删除或类型不匹配，请重新选择"), true); return; }
        this.insertEmbed({ kind: picker.kind, target }, picker);
    }
    private insertEmbed(attrs: EmbedTarget, range: { from: number; to: number }) {
        const view = this.view!;
        const existing = view.state.doc.nodeAt(range.from);
        const transaction = view.state.tr.setSelection(existing?.type.name === 'workbench_embed' ? NodeSelection.create(view.state.doc, range.from) : TextSelection.create(view.state.doc, range.from, range.to));
        const selectedNode = view.state.doc.nodeAt(range.from);
        const node = view.state.schema.nodes.workbench_embed.create(attrs);
        if (selectedNode?.type.name === 'workbench_embed' && range.to === range.from + selectedNode.nodeSize) transaction.replaceWith(range.from, range.to, node);
        else {
            transaction.replaceSelectionWith(node);
            const after = transaction.selection.to;
            if (after === transaction.doc.content.size) transaction.insert(after, view.state.schema.nodes.paragraph.create());
        }
        this.onCommand(); this.emit({ picker: null, slash: null }); view.dispatch(transaction.scrollIntoView()); view.focus();
    }
    editEmbed(position: number, kind: Picker['kind'], initial = '') { const node = this.view?.state.doc.nodeAt(position); if (node?.type.name === 'workbench_embed') this.openPicker(kind, { from: position, to: position + node.nodeSize }, initial); }
    deleteEmbed(position: number) { if (!this.writable()) return; const view = this.view!, node = view.state.doc.nodeAt(position); if (node?.type.name !== 'workbench_embed') return; this.onCommand(); view.dispatch(view.state.tr.delete(position, position + node.nodeSize).scrollIntoView()); view.focus(); }
    selectEmbed(position: number) { const view = this.view; if (view) { view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, position))); view.focus(); } }
    run = (id: string) => {
        if (id === 'undo' || id === 'redo') { void stepHistory(id, this.documentId); return; }
        if (!this.writable()) return;
        if (id === 'link' || id === 'view' || id === 'doc') { this.openPicker(id); return; }
        if (id === 'image') {
            const slash = this.state.slash;
            if (slash) { this.onCommand(); this.view!.dispatch(this.view!.state.tr.delete(slash.from, slash.to)); this.emit({ slash: null }); }
            this.images.choose(); return;
        }
        const view = this.view!;
        const slash = this.state.slash;
        let state = view.state;
        const base = state.tr;
        if (slash) { base.delete(slash.from, slash.to); state = state.apply(base); }
        const schema = state.schema;
        const marks: Record<string, string> = { bold: 'strong', italic: 'emphasis', highlight: 'highlight', strikethrough: 'strike_through' };
        const command = id === 'math-inline' || id === 'math-block' ? insertMath(id === 'math-block') : id === 'table' ? insertMarkdownTable : marks[id] ? toggleMark(schema.marks[marks[id]]) : id.startsWith('heading') ? setBlockType(schema.nodes.heading, { level: Number(id.slice(-1)) }) : id === 'bullet_list' || id === 'ordered_list' ? wrapInList(schema.nodes[id]) : id === 'blockquote' ? wrapIn(schema.nodes.blockquote) : id === 'hr' ? null : setBlockType(schema.nodes[id]);
        let applied = false;
        const dispatch = (transaction: typeof base) => { if (slash) { transaction.steps.forEach(step => base.step(step)); base.setSelection(transaction.selection); } this.onCommand(); this.emit({ slash: null }); view.dispatch((slash ? base : transaction).scrollIntoView()); applied = true; };
        if (id === 'hr') dispatch(state.tr.replaceSelectionWith(schema.nodes.hr.create())); else command?.(state, dispatch, view);
        if (!applied) notify(t("当前位置不支持此格式"));
        view.focus();
    };
}
