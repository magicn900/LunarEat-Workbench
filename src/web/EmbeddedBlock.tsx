import { t } from './i18n';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Node } from '@milkdown/prose/model';
import type { EditorView, NodeView } from '@milkdown/prose/view';
import { CollectionGrid } from './CollectionView';
import { DocumentEmbed } from './DocumentEmbed';
import { useSnapshot, navigate } from './state';
import { locked } from './editing';
import { embedText, type EmbedTarget } from '../shared/embeds';
import type { EditorToolsController } from './editorCommands';
import type { Schema } from '@milkdown/prose/model';
function EmbeddedBlock({ attrs, position, controller, parse, schema }: { attrs: EmbedTarget; position: () => number|undefined; controller: EditorToolsController; parse: (text: string) => Node; schema: Schema }) {
    const snapshot = useSnapshot();
    const [menu, setMenu] = useState(false);
    const target = snapshot?.tree[attrs.target];
    const act = (action: (position: number) => void) => { const current = position(); if (current !== undefined) action(current); setMenu(false); };
    return <section className="embed-block" aria-label={t("文档嵌入块")}><header className="embed-block-tools" onContextMenu={event => { event.preventDefault(); event.stopPropagation(); setMenu(true); }}>
        <button className="embed-handle" aria-label={t("选中嵌入块")} title={t("选中整个嵌入块，可删除或复制")} onClick={() => act(current => controller.selectEmbed(current))}>⠿</button><span>{t("嵌入")}{attrs.kind === 'view' ? t("视图") : t("文档")} · {target?.title || t("目标不存在")}</span><div className="spacer"/><button disabled={!target} onClick={() => navigate(attrs.target)}>{t("打开原")}{attrs.kind === 'view' ? t("视图") : t("文档")} ↗</button><div className="embed-menu" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setMenu(false); }}><button aria-label={t("嵌入块操作")} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>⋯</button>{menu && <div role="menu" aria-label={t("嵌入块操作")} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setMenu(false); } const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]; if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const index = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); } }}><button role="menuitem" disabled={locked()} onClick={() => act(current => controller.editEmbed(current, attrs.kind))}>{t("更换嵌入目标")}</button><button role="menuitem" disabled={locked()} onClick={() => act(current => controller.editEmbed(current, 'source', embedText(attrs)))}>{t("编辑嵌入语法")}</button><button role="menuitem" className="danger" disabled={locked()} onClick={() => act(current => controller.deleteEmbed(current))}>{t("移除此处嵌入")}</button></div>}</div>
    </header>{attrs.kind === 'view' ? <CollectionGrid viewId={attrs.target} compact/> : <DocumentEmbed id={attrs.target} parse={parse} schema={schema}/>}</section>;
}
export function createEmbedNodeView(controller: EditorToolsController, parse: (text: string) => Node, schema: Schema) {
    return (node: Node, _view: EditorView, getPos: () => number|undefined): NodeView => {
        const dom = document.createElement('div'); dom.className = 'embedded-host'; dom.contentEditable = 'false';
        const root = createRoot(dom);
        const render = (current: Node) => root.render(<EmbeddedBlock attrs={current.attrs as EmbedTarget} position={getPos} controller={controller} parse={parse} schema={schema}/>);
        render(node);
        return { dom, update: next => { if (next.type.name !== 'workbench_embed') return false; render(next); return true; }, ignoreMutation: () => true, stopEvent: event => event.type !== 'dragstart' && event.type !== 'dragend', selectNode: () => dom.classList.add('ProseMirror-selectednode'), deselectNode: () => dom.classList.remove('ProseMirror-selectednode'), destroy: () => { queueMicrotask(() => root.unmount()); } };
    };
}
