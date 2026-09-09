import { $nodeSchema, $remark } from '@milkdown/utils';
import type { Node } from '@milkdown/prose/model';
import { Transform } from '@milkdown/prose/transform';
export const documentSchemaVersion = 2;
import { parseEmbed, type EmbedTarget } from './markdownReferences.js';
export { parseEmbed, type EmbedTarget } from './markdownReferences.js';
export function embedText(attrs: EmbedTarget) { const text = ':::' + attrs.kind + '[' + attrs.target + ']'; if (!parseEmbed(text)) throw Error('嵌入目标不合法'); return text; }
type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };
export const embedRemark = $remark('workbench-embed', () => () => (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
        if (node.type === 'paragraph' && node.children?.length === 1 && node.children[0].type === 'text' && parseEmbed(node.children[0].value || '')) { node.type = 'workbenchEmbed'; node.value = node.children[0].value; delete node.children; }
        else node.children?.forEach(visit);
    };
    visit(tree);
});
export const embedSchema = $nodeSchema('workbench_embed', () => ({
    group: 'block', atom: true, isolating: true, selectable: true, draggable: true,
    attrs: { kind: { default: 'view' }, target: { default: '' } },
    parseDOM: [{ tag: 'div[data-workbench-embed]', getAttrs: element => parseEmbed((element as HTMLElement).getAttribute('data-workbench-embed') || '') || false }],
    toDOM: node => ['div', { 'data-workbench-embed': embedText(node.attrs as EmbedTarget), contenteditable: 'false' }, embedText(node.attrs as EmbedTarget)],
    parseMarkdown: { match: node => node.type === 'workbenchEmbed', runner: (state, node, type) => { state.addNode(type, parseEmbed(String(node.value)) || undefined); } },
    toMarkdown: { match: node => node.type.name === 'workbench_embed', runner: (state, node) => { state.addNode('html', undefined, embedText(node.attrs as EmbedTarget)); } }
}));
export function normalizeEmbeds(doc: Node) {
    const transform = new Transform(doc);
    doc.descendants((node, position) => {
        if (node.type.name !== 'paragraph' || node.childCount !== 1 || !node.firstChild?.isText || node.firstChild.marks.length) return;
        const attrs = parseEmbed(node.textContent);
        if (attrs) transform.replaceWith(transform.mapping.map(position), transform.mapping.map(position + node.nodeSize), doc.type.schema.nodes.workbench_embed.create(attrs));
    });
    return transform;
}
