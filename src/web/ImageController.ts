import { Plugin, PluginKey, NodeSelection, type Transaction } from '@milkdown/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/prose/view';
import { randomUUID } from './uuid';
import { t } from './i18n';
import { getSnapshot, notify } from './state';
import { editingChanged, locked, registerBuffer } from './editing';
import { imageTypes, imageUploadLimit } from '../shared/assets';

type Range = { from: number; to: number; invalid?: boolean; original?: string; alt?: string };
type Upload = Range & { id: string; file: File; preview: string; projectId: string; status: 'waiting' | 'uploading' | 'failed'; error?: string; request?: AbortController; uploaded?: string };
type SelectedImage = { position: number; src: string; alt: string };
type ImageState = { selected: SelectedImage | null; preview: { src: string; alt: string } | null; pending: number };

export class ImageController {
    private view: EditorView | null = null;
    private uploads = new Map<string, Upload>();
    private picker: { range: Range; input: HTMLInputElement } | null = null;
    private listeners = new Set<() => void>();
    private state: ImageState = { selected: null, preview: null, pending: 0 };
    private queue: Promise<void> = Promise.resolve();
    constructor(readonly documentId: string, private onCommand: () => void) {}
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
    snapshot = () => this.state;
    private emit() {
        const selection = this.view?.state.selection;
        const selected = selection instanceof NodeSelection && selection.node.type.name === 'image' ? { position: selection.from, src: selection.node.attrs.src, alt: selection.node.attrs.alt } : null;
        this.state = { ...this.state, selected, pending: this.uploads.size };
        this.listeners.forEach(listener => listener());
    }
    private refresh() { this.view?.dispatch(this.view.state.tr.setMeta('image-upload', true)); this.emit(); editingChanged(); }
    private map(transaction: Transaction, range: Range) {
        const from = transaction.mapping.mapResult(range.from, 1);
        const to = transaction.mapping.mapResult(range.to, range.from === range.to ? 1 : -1);
        range.invalid ||= from.deletedAcross || to.deletedAcross;
        range.from = from.pos;
        range.to = Math.max(from.pos, to.pos);
    }
    plugin = new Plugin({
        key: new PluginKey('workbench-image-upload'),
        state: { init: () => null, apply: transaction => {
            if (transaction.docChanged) {
                for (const upload of this.uploads.values()) this.map(transaction, upload);
                if (this.picker) this.map(transaction, this.picker.range);
            }
            return null;
        } },
        props: {
            decorations: state => DecorationSet.create(state.doc, [...this.uploads.values()].map(upload => Decoration.widget(Math.min(upload.from, state.doc.content.size), () => {
                const wrapper = document.createElement('span');
                wrapper.className = 'image-upload-placeholder';
                wrapper.contentEditable = 'false';
                wrapper.setAttribute('role', 'group');
                wrapper.setAttribute('aria-label', t('图片上传'));
                const preview = document.createElement('img'); preview.src = upload.preview; preview.alt = upload.file.name;
                const status = document.createElement('span'); status.setAttribute('role', 'status'); status.textContent = upload.error ? t(upload.error) : t(upload.status === 'waiting' ? '等待上传…' : '正在上传图片…');
                wrapper.append(preview, status);
                if (upload.status === 'failed') {
                    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = t('重试上传'); retry.disabled = !!upload.invalid; retry.onclick = () => this.schedule(upload); wrapper.append(retry);
                }
                const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = t('取消上传'); cancel.onclick = () => this.cancel(upload.id); wrapper.append(cancel);
                return wrapper;
            }, { side: 1, key: upload.id + ':' + upload.status + ':' + upload.error, stopEvent: () => true }))),
            handlePaste: (_view, event) => {
                const files = [...(event.clipboardData?.files || [])].filter(file => file.type.startsWith('image/'));
                if (!files.length) return false;
                event.preventDefault(); this.add(files); return true;
            },
            handleDrop: (view, event, _slice, moved) => {
                if (moved) return false;
                const files = [...(event.dataTransfer?.files || [])].filter(file => file.type.startsWith('image/'));
                if (!files.length) return false;
                event.preventDefault();
                const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
                if (position !== undefined) this.add(files, { from: position, to: position });
                return true;
            }
        },
        view: view => {
            this.view = view;
            const unregister = registerBuffer('image-upload:' + this.documentId, { dirty: () => this.uploads.size > 0 || !!this.picker, flush: async () => { if (this.uploads.size || this.picker) throw Error(t('图片仍在上传或等待处理，请等待完成、重试或取消上传')); } });
            const preview = (event: MouseEvent) => {
                const image = (event.target as Element).closest<HTMLImageElement>('img');
                if (image && !image.closest('.image-upload-placeholder')) { event.preventDefault(); this.openPreview(image.getAttribute('src') || '', image.alt); }
            };
            view.dom.addEventListener('dblclick', preview, true);
            this.emit();
            return { update: next => { this.view = next; this.emit(); }, destroy: () => {
                this.view = null;
                view.dom.removeEventListener('dblclick', preview, true);
                for (const upload of this.uploads.values()) { upload.request?.abort(); URL.revokeObjectURL(upload.preview); }
                this.uploads.clear(); this.picker?.input.remove(); this.picker = null; unregister();
            } };
        }
    });
    private writable() { return !!this.view && this.view.editable && !this.view.composing && !locked(); }
    choose = (replace = false) => {
        if (!this.writable() || this.picker) return;
        const selection = this.state.selected;
        if (replace && !selection) return;
        const from = replace ? selection!.position : this.view!.state.selection.from;
        const range: Range = { from, to: replace ? from + this.view!.state.doc.nodeAt(from)!.nodeSize : from, ...(replace ? { original: selection!.src, alt: selection!.alt } : {}) };
        const input = document.createElement('input'); input.type = 'file'; input.accept = imageTypes.join(','); input.multiple = !replace; input.hidden = true;
        this.picker = { range, input };
        const close = () => { this.picker = null; input.remove(); editingChanged(); };
        input.onchange = () => { const files = [...(input.files || [])]; close(); this.add(files, range); };
        input.oncancel = close;
        document.body.append(input); editingChanged(); input.click();
    };
    private add(files: File[], range?: Range) {
        if (!this.writable()) { notify(t('当前不能插入图片，请等待输入结束或收回控制权'), true); return; }
        if (range?.invalid) { notify(t('图片插入位置已删除，请重新插入'), true); return; }
        const projectId = getSnapshot()!.project.id;
        const from = this.view!.state.selection.from;
        if (files.length + this.uploads.size > 5) { notify(t('一次最多处理 5 张图片'), true); return; }
        for (const file of files) {
            if (!imageTypes.includes(file.type) || !file.size || file.size > imageUploadLimit) { notify(t('请选择不超过 10 MB 的 PNG、JPEG 或 WebP 图片'), true); continue; }
            const upload: Upload = { ...(range || { from, to: from }), id: randomUUID(), file, preview: URL.createObjectURL(file), projectId, status: 'waiting' };
            this.uploads.set(upload.id, upload); this.schedule(upload);
        }
        this.refresh();
    }
    private schedule(upload: Upload) {
        if (!this.uploads.has(upload.id) || upload.status === 'uploading') return;
        upload.status = 'waiting'; upload.error = undefined; this.refresh();
        this.queue = this.queue.then(() => this.start(upload));
    }
    private async start(upload: Upload) {
        if (!this.uploads.has(upload.id) || !this.view) return;
        upload.status = 'uploading'; upload.request = new AbortController(); this.refresh();
        try {
            if (!upload.uploaded) {
                const response = await fetch('/api/projects/' + encodeURIComponent(upload.projectId) + '/documents/' + encodeURIComponent(this.documentId) + '/images', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-workbench-client': 'web', 'x-file-name': encodeURIComponent(upload.file.name.slice(0, 120)) }, body: upload.file, signal: upload.request.signal });
                const result = await response.json();
                if (!response.ok) throw Error(result.error || t('图片上传失败，请重试'));
                upload.uploaded = result.url;
            }
            if (!this.view || !this.uploads.has(upload.id)) return;
            if (!this.writable()) throw Error(t('当前不能插入图片，请等待输入结束或收回控制权'));
            if (upload.invalid || upload.original && this.view.state.doc.nodeAt(upload.from)?.attrs.src !== upload.original) throw Error(t('图片插入位置已删除或更改，请取消后重新插入'));
            const image = this.view.state.schema.nodes.image.create({ src: upload.uploaded, alt: upload.alt || upload.file.name, title: '' });
            const transaction = this.view.state.tr.replaceRangeWith(upload.from, upload.to, image);
            this.uploads.delete(upload.id); this.onCommand(); this.view.dispatch(transaction); URL.revokeObjectURL(upload.preview); this.emit(); editingChanged();
        } catch (error: any) {
            if (!this.uploads.has(upload.id)) return;
            upload.status = 'failed'; upload.error = error.message || t('图片上传失败，请重试'); this.refresh();
        }
    }
    cancel = (id: string) => { const upload = this.uploads.get(id); if (!upload) return; this.uploads.delete(id); upload.request?.abort(); URL.revokeObjectURL(upload.preview); this.refresh(); };
    openPreview = (src: string, alt: string) => { this.state = { ...this.state, preview: { src, alt } }; this.emit(); };
    closePreview = () => { this.state = { ...this.state, preview: null }; this.emit(); };
    editAlt = (alt: string) => {
        const selected = this.state.selected;
        if (!this.writable() || !selected) return;
        const node = this.view!.state.doc.nodeAt(selected.position)!;
        const transaction = this.view!.state.tr.setNodeMarkup(selected.position, undefined, { ...node.attrs, alt });
        transaction.setSelection(NodeSelection.create(transaction.doc, selected.position));
        this.onCommand(); this.view!.dispatch(transaction);
    };
    remove = () => {
        const selected = this.state.selected;
        if (!this.writable() || !selected) return;
        const node = this.view!.state.doc.nodeAt(selected.position)!;
        this.onCommand(); this.view!.dispatch(this.view!.state.tr.delete(selected.position, selected.position + node.nodeSize)); this.view!.focus();
    };
}
