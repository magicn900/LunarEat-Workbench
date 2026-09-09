import { BoundedCache } from './cache.js';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
export type EmbedTarget = { kind: 'view'|'doc'; target: string };
export function parseEmbed(text: string): EmbedTarget | null { const match = /^:::(view|doc)\[([a-zA-Z0-9_-]+)\]$/.exec(text); return match ? { kind: match[1] as EmbedTarget['kind'], target: match[2] } : null; }

type MarkdownNode = { type: string; value?: string; url?: string; identifier?: string; children?: MarkdownNode[] };
const parser = unified().use(remarkParse).use(remarkGfm);
const cache = new BoundedCache<{ documents: string[]; views: string[] }>(2 * 1024 * 1024, 256);
export function markdownReferences(body: string) {
    const cached = cache.get(body);
    if (cached) return { documents: [...cached.documents], views: [...cached.views] };
    const tree = parser.parse(body) as MarkdownNode;
    const definitions = new Map<string,string>();
    const documents = new Set<string>(), views = new Set<string>();
    const walk = (node: MarkdownNode, visit: (node: MarkdownNode) => void) => { visit(node); node.children?.forEach(child => walk(child, visit)); };
    walk(tree, node => { if (node.type === 'definition' && node.identifier && node.url && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url); });
    walk(tree, node => {
        const url = node.type === 'link' ? node.url : node.type === 'linkReference' ? definitions.get(node.identifier || '') : undefined;
        const target = url && /^doc:([a-zA-Z0-9_-]+)(?:[#?].*)?$/.exec(url);
        if (target) documents.add(target[1]);
        if (node.type === 'paragraph' && node.children?.length === 1 && node.children[0].type === 'text') {
            const embed = parseEmbed(node.children[0].value || '');
            if (embed) (embed.kind === 'view' ? views : documents).add(embed.target);
        }
    });
    const result = { documents: [...documents], views: [...views] };
    cache.set(body, result, 128 + body.length * 2 + [...documents, ...views].reduce((size, id) => size + 32 + id.length * 2, 0));
    return { documents: [...result.documents], views: [...result.views] };
}
