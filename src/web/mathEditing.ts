import { Plugin, TextSelection, NodeSelection, Selection, type Command } from '@milkdown/prose/state';
import type { Node as ProseNode } from '@milkdown/prose/model';
import type { EditorView, NodeView } from '@milkdown/prose/view';
import { mathPreviewLimits } from '../shared/mathLimits';
import { isMath } from '../shared/math';
import { renderMath } from './mathRendering';
import { locked } from './editing';
import { t } from './i18n';

export const insertMath = (display: boolean): Command => (state, dispatch) => {
    if (isMath(state.selection.$from.parent.type.name) || state.selection.$from.parent.type.spec.code) return false;
    const text = state.doc.textBetween(state.selection.from, state.selection.to, ' ') || 'x';
    const node = state.schema.nodes[display ? 'math_block' : 'math_inline'].create(null, state.schema.text(text));
    const transaction = state.tr.replaceSelectionWith(node, false);
    let position: number | undefined;
    transaction.doc.descendants((current, offset) => { if (current === node) position = offset; });
    if (position === undefined) return false;
    transaction.setSelection(TextSelection.create(transaction.doc, position + 1, position + 1 + text.length));
    dispatch?.(transaction);
    return true;
};
function leave(view: EditorView, position: number, node: ProseNode, direction: number) {
    const transaction = view.state.tr;
    const boundary = direction < 0 ? position : position + node.nodeSize;
    if (node.isBlock && direction > 0 && boundary === transaction.doc.content.size && view.editable && !locked()) transaction.insert(boundary, view.state.schema.nodes.paragraph.create());
    const selection = Selection.near(transaction.doc.resolve(boundary), direction);
    transaction.setSelection(isMath(selection.$from.parent.type.name) ? NodeSelection.create(transaction.doc, position) : selection);
    view.dispatch(transaction.scrollIntoView());
}
class MathView implements NodeView {
    readonly dom: HTMLElement;
    readonly contentDOM: HTMLElement;
    private output: HTMLElement;
    private preview: HTMLElement | null = null;
    private previewSize: ResizeObserver | null = null;
    private cancelOutput = () => {};
    private cancelPreview = () => {};
    private delayed: ReturnType<typeof setTimeout> | undefined;
    private source = '';
    private active = false;
    constructor(private node: ProseNode, private view: EditorView, private getPos: () => number | undefined, private reposition: () => void, private remove: () => void) {
        const display = node.type.name === 'math_block';
        this.dom = document.createElement(display ? 'div' : 'span');
        this.dom.className = 'math-node'; this.dom.dataset.math = display ? 'block' : 'inline';
        this.contentDOM = document.createElement('span'); this.contentDOM.className = 'math-source';
        this.output = document.createElement('span'); this.output.className = 'math-rendered'; this.output.contentEditable = 'false';
        this.dom.append(this.contentDOM, this.output);
        this.dom.addEventListener('mousedown', event => {
            if (this.active || !this.output.contains(event.target as globalThis.Node)) return;
            const position = this.getPos(); if (position === undefined) return;
            event.preventDefault();
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, position + 1)));
            view.focus(); this.refresh();
        });
        this.source = node.textContent; this.paint();
    }
    update(node: ProseNode) {
        if (node.type !== this.node.type) return false;
        this.node = node;
        if (this.source !== node.textContent) {
            this.source = node.textContent;
            this.cancelOutput(); this.cancelPreview(); clearTimeout(this.delayed);
            this.output.textContent = this.source || t('空公式');
            this.delayed = setTimeout(() => this.paint(), 100);
        }
        return true;
    }
    private paint() {
        this.cancelOutput(); this.cancelOutput = renderMath(this.output, this.source, this.node.isBlock);
        if (this.preview) {
            this.cancelPreview(); this.cancelPreview = renderMath(this.preview.querySelector<HTMLElement>('.math-preview-content')!, this.source, this.node.isBlock);
        }
    }
    refresh() {
        const position = this.getPos();
        const { selection } = this.view.state;
        const active = position !== undefined && this.view.hasFocus() && selection instanceof TextSelection && selection.from >= position + 1 && selection.to <= position + this.node.nodeSize - 1 && selection.$from.parent.type === this.node.type;
        if (active !== this.active) {
            this.active = active; this.dom.classList.toggle('math-editing', active);
            if (active) {
                this.preview = document.createElement('aside'); this.preview.className = 'math-preview'; this.preview.setAttribute('role', 'note'); this.preview.setAttribute('aria-label', t('公式实时预览'));
                const label = document.createElement('small'); label.textContent = t('实时预览 · 自动保存');
                const content = document.createElement('div'); content.className = 'math-preview-content';
                this.preview.append(label, content); document.body.append(this.preview);
                this.previewSize = new ResizeObserver(this.reposition); this.previewSize.observe(this.preview);
                this.preview.addEventListener('mousedown', event => event.preventDefault());
                this.cancelPreview = renderMath(content, this.source, this.node.isBlock);
            } else { this.cancelPreview(); this.previewSize?.disconnect(); this.previewSize = null; this.preview?.remove(); this.preview = null; }
        }
        this.reposition();
    }
    positionPreview = () => {
        if (!this.preview) return;
        const rect = this.dom.getBoundingClientRect();
        const editorRect = this.view.dom.closest('.document-scroll')?.getBoundingClientRect();
        const visible = rect.bottom > Math.max(0, editorRect?.top || 0) && rect.top < Math.min(innerHeight, editorRect?.bottom || innerHeight);
        this.preview.hidden = !visible;
        const width = Math.min(360, innerWidth - 24);
        this.preview.style.width = width + 'px';
        const right = rect.right + 12;
        const side = right + width <= innerWidth - 12;
        this.preview.style.left = Math.max(12, Math.min(side ? right : rect.left, innerWidth - width - 12)) + 'px';
        const height = this.preview.offsetHeight;
        this.preview.style.top = Math.max(12, Math.min(side ? rect.top : rect.bottom + 32, innerHeight - height - 12)) + 'px';
    };
    ignoreMutation(mutation: Parameters<NonNullable<NodeView['ignoreMutation']>>[0]) { return mutation.type !== 'selection' && !this.contentDOM.contains(mutation.target); }
    destroy() { this.previewSize?.disconnect(); clearTimeout(this.delayed); this.cancelOutput(); this.cancelPreview(); this.preview?.remove(); this.remove(); }
}
export function mathEditingPlugin(parse: (source: string) => ProseNode) {
    const nodes = new WeakMap<globalThis.Node, MathView>();
    let editorView: EditorView | null = null, active: MathView | undefined, frame: number | undefined;
    const reposition = () => {
        if (active && frame === undefined) frame = requestAnimationFrame(() => { frame = undefined; active?.positionPreview(); });
    };
    const refresh = () => {
        if (!editorView) return;
        const { selection } = editorView.state;
        let next: MathView | undefined;
        if (editorView.hasFocus() && selection instanceof TextSelection && isMath(selection.$from.parent.type.name) && selection.to <= selection.$from.end()) {
            const dom = editorView.nodeDOM(selection.$from.before());
            if (dom) next = nodes.get(dom);
        }
        const previous = active; active = next;
        if (previous !== active) previous?.refresh();
        active?.refresh();
    };
    const factory = (node: ProseNode, view: EditorView, getPos: () => number | undefined) => {
        const instance = new MathView(node, view, getPos, reposition, () => { nodes.delete(instance.dom); if (active === instance) active = undefined; });
        nodes.set(instance.dom, instance); return instance;
    };
    return new Plugin({
        props: {
            nodeViews: { math_inline: factory, math_block: factory },
            handleDOMEvents: { focus: () => { queueMicrotask(refresh); return false; }, blur: () => { queueMicrotask(refresh); return false; } },
            handleTextInput(view, from, to, text) {
                if (text !== '$' || from !== to || view.composing || locked() || !view.editable) return false;
                const resolved = view.state.doc.resolve(from);
                if (resolved.parent.type.spec.code || resolved.marks().some(mark => mark.type.spec.code)) return false;
                const previous = resolved.nodeBefore;
                if (!previous?.isText) return false;
                const value = previous.text || '';
                if (value.includes(String.fromCharCode(96))) return false;
                const opening = value.lastIndexOf('$');
                if (opening < 0 || value[opening - 1] === '$' || value.length - opening > mathPreviewLimits.sourceLength + 2) return false;
                let escapes = 0;
                for (let index = opening - 1; index >= 0 && value.charCodeAt(index) === 92; index--) escapes++;
                if (escapes % 2) return false;
                const parsed = parse(value.slice(opening) + '$').firstChild;
                const formula = parsed?.childCount === 1 ? parsed.firstChild : null;
                if (formula?.type.name !== 'math_inline') return false;
                const start = from - value.length + opening;
                const transaction = view.state.tr.replaceWith(start, to, formula);
                view.dispatch(transaction.setSelection(TextSelection.create(transaction.doc, start + 1 + formula.content.size)));
                return true;
            },
            handleKeyDown(view, event) {
                if (event.isComposing || view.composing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return false;
                const { selection } = view.state;
                const parent = selection.$from.parent;
                if (event.key === 'Enter' && parent.type.name === 'paragraph' && parent.textContent === '$$' && selection.empty && selection.$from.parentOffset === 2 && view.editable && !locked()) {
                    const position = selection.$from.before();
                    const node = view.state.schema.nodes.math_block.create(null, view.state.schema.text('x'));
                    const transaction = view.state.tr.replaceWith(position, selection.$from.after(), node);
                    view.dispatch(transaction.setSelection(TextSelection.create(transaction.doc, position + 1, position + 2)));
                    return true;
                }
                if (isMath(parent.type.name)) {
                    const position = selection.$from.before();
                    if (!parent.content.size && ['Backspace', 'Delete'].includes(event.key) && view.editable && !locked()) { view.dispatch(view.state.tr.delete(position, position + parent.nodeSize)); return true; }
                    if (event.key === 'Escape' || (event.key === 'Enter' && parent.isInline)) { leave(view, position, parent, 1); return true; }
                    if (event.key === 'Enter' && parent.isBlock && !locked() && view.editable) { view.dispatch(view.state.tr.insertText('\n')); return true; }
                    if (!selection.empty || event.shiftKey) return false;
                    if ((event.key === 'ArrowLeft' || event.key === 'Backspace') && selection.$from.parentOffset === 0) { leave(view, position, parent, -1); return true; }
                    if ((event.key === 'ArrowRight' || event.key === 'Delete') && selection.$from.parentOffset === parent.content.size) { leave(view, position, parent, 1); return true; }
                    return false;
                }
                if (event.shiftKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return false;
                const forward = event.key === 'ArrowRight';
                const node = selection instanceof NodeSelection ? selection.node : forward ? selection.$from.nodeAfter : selection.$from.nodeBefore;
                if (!node || !isMath(node.type.name) || (!selection.empty && !(selection instanceof NodeSelection))) return false;
                const position = selection instanceof NodeSelection || forward ? selection.from : selection.from - node.nodeSize;
                view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, position + 1 + (forward ? 0 : node.content.size)))); return true;
            }
        },
        view: view => {
            editorView = view; refresh();
            window.addEventListener('scroll', reposition, true); window.addEventListener('resize', reposition);
            return { update: refresh, destroy: () => { window.removeEventListener('scroll', reposition, true); window.removeEventListener('resize', reposition); if (frame !== undefined) cancelAnimationFrame(frame); editorView = null; active = undefined; } };
        }
    });
}
