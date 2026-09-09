import { JSDOM } from 'jsdom';
import { Editor, rootCtx, parserCtx, serializerCtx, schemaCtx } from '@milkdown/core';
import { commonmark, headingIdGenerator } from '@milkdown/preset-commonmark';
import { Transform } from '@milkdown/prose/transform';
import { gfm } from '@milkdown/preset-gfm';
import { embedRemark, embedSchema } from '../shared/embeds.js';
export async function createCodec() {
    const dom = new JSDOM('<!doctype html><html><body><div id="editor"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
    for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'Element', 'MutationObserver', 'DOMParser', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'CustomEvent', 'Event', 'KeyboardEvent'])
        Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
    for (const key of ['addEventListener', 'removeEventListener', 'dispatchEvent'])
        Object.defineProperty(globalThis, key, { value: (dom.window as any)[key].bind(dom.window), configurable: true, writable: true });
    const editor = await Editor.make().config(ctx => ctx.set(rootCtx, dom.window.document.getElementById('editor'))).use(commonmark).use(gfm).use(embedRemark).use(embedSchema).create();
    const codec = editor.action(ctx => {
        const parseMarkdown = ctx.get(parserCtx);
        const headingId = ctx.get(headingIdGenerator.key);
        return {
            parse(text: string) {
                const doc = parseMarkdown(text);
                const transform = new Transform(doc);
                doc.descendants((node, position) => {
                    if (node.type.name === 'heading') transform.setNodeMarkup(position, undefined, { ...node.attrs, id: headingId(node) });
                });
                return transform.doc;
            },
            serialize: ctx.get(serializerCtx),
            schema: ctx.get(schemaCtx)
        };
    });
    return { ...codec, close: async () => { await editor.destroy(); dom.window.close(); } };
}
export type Codec = Awaited<ReturnType<typeof createCodec>>;
