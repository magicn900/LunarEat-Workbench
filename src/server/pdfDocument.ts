import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import katex from 'katex';
import { remarkHighlight } from '../shared/highlight.js';
import { parseEmbed } from '../shared/markdownReferences.js';
import { displayValue, fieldValue, queryViewResult, viewFilters } from '../shared/viewQuery.js';
import { pdfExportLimits, type PdfInspection, type PdfOptions, type PdfViewSummary } from '../shared/pdfExport.js';
import { mathPreviewLimits } from '../shared/mathLimits.js';
import type { CollectionView, Field, Tree } from '../shared/model.js';
import { Fault } from './auth.js';

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[]; depth?: number; url?: string; alt?: string; identifier?: string; checked?: boolean | null; ordered?: boolean; start?: number; align?: (string | null)[] };
export type PdfContext = { head: string; at: string; timeZone: string; project: { id: string; name: string }; origin: string; source: string; signal?: AbortSignal; inspectionOnly?: boolean };
export type PdfImage = { source?: string; error?: string };
export type PdfImageResolver = (source: string) => Promise<PdfImage>;
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkHighlight).use(remarkMath);
export const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));

export async function preparePdfDocument(tree: Tree, id: string, context: PdfContext, options: PdfOptions, resolveImage: PdfImageResolver) {
    const entity = tree[id];
    if (entity?.kind !== 'object') throw new Fault(404, '文档不存在');
    const translated = (chinese: string, english: string) => options.language === 'en' ? english : chinese;
    const inspection: PdfInspection = { title: entity.title, head: context.head, at: context.at, source: context.source, views: [], warnings: [] };
    const warn = (kind: PdfInspection['warnings'][number]['kind'], message: string) => { if (!inspection.warnings.some(warning => warning.kind === kind && warning.message === message)) inspection.warnings.push({ kind, message }); };
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: context.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(context.at)).map(part => [part.type, part.value]));
    const queryDate = new Date(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 12);
    const date = new Intl.DateTimeFormat(options.language, { timeZone: context.timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(context.at));
    let embeddedCount = 0;
    let totalRows = 0;
    let sourceBytes = 0;
    const headings: { id: string; level: number; title: string }[] = [];
    const text = (node: MarkdownNode): string => node.value ?? (node.children || []).map(text).join('');
    const link = (target: string) => context.origin + '/?project=' + encodeURIComponent(context.project.id) + '&document=' + encodeURIComponent(target);
    const href = (source: string) => {
        const reference = /^doc:([a-zA-Z0-9_-]+)(?:[#?].*)?$/.exec(source);
        if (reference) return tree[reference[1]]?.kind === 'object' ? link(reference[1]) : null;
        if (source.startsWith('#')) return source;
        try { const url = new URL(source); return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : null; } catch { return null; }
    };
    const format = (value: unknown, field?: Field): string => {
        if (value == null || value === '' || Array.isArray(value) && !value.length) return '—';
        if (Array.isArray(value)) return value.map(item => format(item, field)).join('、');
        if (field?.type === 'reference') {
            const target = tree[String(value)];
            if (!target) { warn('field', translated('引用字段包含不可用目标', 'A reference field contains an unavailable target')); return translated('引用不可用', 'Unavailable reference'); }
            return `<a href="${escapeHtml(link(target.id))}">${escapeHtml(target.title)}</a>`;
        }
        if (typeof value === 'boolean') return value ? translated('是', 'Yes') : translated('否', 'No');
        return escapeHtml(displayValue(value, field, tree));
    };
    const conditions = (view: CollectionView, fields: Field[]) => {
        const labels: Record<string, string> = options.language === 'en' ? { contains: 'contains', equals: '=', startsWith: 'starts with', empty: 'is empty', notEmpty: 'is set', gt: '>', gte: '≥', lt: '<', lte: '≤', between: 'between', in: 'in', today: 'today', last7days: 'last 7 days' } : { contains: '包含', equals: '等于', startsWith: '开头是', empty: '未设置', notEmpty: '已设置', gt: '大于', gte: '不小于', lt: '小于', lte: '不大于', between: '介于', in: '属于', today: '今天', last7days: '最近 7 天' };
        const descriptions = viewFilters(view).map(filter => {
            const field = fields.find(field => field.key === filter.key);
            const value = filter.value == null ? '' : Array.isArray(filter.value) ? filter.value.map(item => displayValue(item, field, tree)).join('、') : displayValue(filter.value, field, tree);
            return [field?.label || translated('未知字段', 'Unknown field'), labels[filter.operator], value].filter(Boolean).join(' ');
        });
        if (view.search?.trim()) descriptions.push(translated('搜索：', 'Search: ') + view.search.trim());
        if (view.sort) descriptions.push(translated('排序：', 'Sort: ') + (fields.find(field => field.key === view.sort!.key)?.label || translated('未知字段', 'Unknown field')) + (view.sort.descending ? translated(' 降序', ' descending') : translated(' 升序', ' ascending')));
        return descriptions.join('；') || translated('未设置筛选与排序', 'No filters or sorting');
    };
    const renderView = async (target: string, key: string) => {
        const view = tree[target];
        const collection = view?.kind === 'view' ? tree[view.collection] : null;
        const mode = options.viewModes[key] || 'original';
        if (view?.kind !== 'view' || collection?.kind !== 'collection') {
            const message = translated('嵌入视图不存在或不可访问', 'The embedded view is missing or unavailable');
            inspection.views.push({ key, id: target, title: message, layout: 'table', rows: 0, columns: 0, conditions: '', mode, available: false });
            warn('embed', message);
            return `<section class="unavailable">${escapeHtml(message)}</section>`;
        }
        const allFields: Field[] = [{ key: 'title', label: translated('名称', 'Name'), type: 'text', required: true }, ...collection.fields];
        const fields = [allFields[0], ...view.columns.filter(key => key !== 'title').map(key => collection.fields.find(field => field.key === key)).filter((field): field is Field => !!field)];
        if (view.columns.some(key => !allFields.some(field => field.key === key))) warn('field', translated('视图中有已删除的字段，请检查后导出', 'The view contains deleted fields; check before exporting'));
        const result = queryViewResult(tree, { ...view, pagination: { pageSize: null } }, 1, queryDate);
        const summary: PdfViewSummary = { key, id: target, title: view.title, layout: view.layout, rows: result.filteredCount, columns: fields.length, conditions: conditions(view, allFields), mode, available: true };
        inspection.views.push(summary);
        if (mode === 'link') return `<section class="export-view"><h3>${escapeHtml(view.title)}</h3><p><a href="${escapeHtml(link(view.id))}">${translated('打开工作站视图', 'Open the workbench view')}</a> · ${result.filteredCount} ${translated('条匹配记录，未展开', 'matching records, not expanded')}</p></section>`;
        if (context.inspectionOnly && (result.filteredCount > pdfExportLimits.rowsPerView || totalRows + result.filteredCount > pdfExportLimits.totalRows)) return '';
        if (result.filteredCount > pdfExportLimits.rowsPerView) throw new Fault(413, '单个嵌入视图最多导出 2000 条，请缩小筛选范围或仅保留链接');
        totalRows += result.filteredCount;
        if (totalRows > pdfExportLimits.totalRows) throw new Fault(413, '嵌入视图合计最多导出 5000 条，请缩小筛选范围或仅保留链接');
        const layout = mode === 'table' ? 'table' : view.layout;
        const header = `<header><h3>${escapeHtml(view.title)}</h3><div class="view-summary">${escapeHtml(summary.conditions)}<br>${result.filteredCount} ${translated('条 · 导出时的静态快照', 'records · static export snapshot')}</div></header>`;
        if (!result.rows.length) return `<section class="export-view">${header}<p class="empty">${translated('当前条件下没有记录', 'No records match the current conditions')}</p></section>`;
        const rowTitle = (row: typeof result.rows[number]) => `<a href="${escapeHtml(link(row.id))}">${escapeHtml(row.title)}</a>`;
        if (layout === 'table') {
            const weights = fields.map(field => field.key === 'title' ? 1.5 : field.type === 'text' ? 3 : ['number', 'boolean'].includes(field.type) ? 0.7 : 1.3);
            const weightTotal = weights.reduce((total, weight) => total + weight, 0);
            const columns = '<colgroup>' + weights.map(weight => `<col style="width:${(weight / weightTotal * 100).toFixed(2)}%">`).join('') + '</colgroup>';
            const rows = result.rows.map(row => '<tr>' + fields.map(field => `<td>${field.key === 'title' ? rowTitle(row) : format(fieldValue(row, field.key), field)}</td>`).join('') + '</tr>').join('');
            return `<section class="export-view">${header}<table class="collection-table">${columns}<thead><tr>${fields.map(field => `<th>${escapeHtml(field.label)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></section>`;
        }
        const records = result.rows.map(row => `<article class="record"><h4>${rowTitle(row)}</h4><dl>${fields.slice(1).map(field => `<div><dt>${escapeHtml(field.label)}</dt><dd>${format(fieldValue(row, field.key), field)}</dd></div>`).join('')}</dl></article>`).join('');
        return `<section class="export-view">${header}<div class="records ${layout}">${records}</div></section>`;
    };
    const renderDocument = async (documentId: string, level = 0): Promise<string> => {
        context.signal?.throwIfAborted();
        const document = tree[documentId];
        if (document?.kind !== 'object') { const message = translated('嵌入文档不存在或不可访问', 'The embedded document is missing or unavailable'); warn('embed', message); return `<p class="unavailable">${escapeHtml(message)}</p>`; }
        sourceBytes += Buffer.byteLength(document.body);
        if (sourceBytes > pdfExportLimits.htmlBytes) throw new Fault(413, '导出内容过大，请缩小文档或嵌入范围');
        const root = parser.parse(document.body) as MarkdownNode;
        const definitions = new Map<string, string>();
        const collect = (node: MarkdownNode, depth = 0) => { if (depth > 128) throw new Fault(413, '文档结构过深，无法导出'); if (node.type === 'definition' && node.identifier && node.url) definitions.set(node.identifier, node.url); node.children?.forEach(child => collect(child, depth + 1)); };
        collect(root);
        let occurrence = 0;
        const children = async (node: MarkdownNode) => { let output = ''; for (const child of node.children || []) output += await render(child); return output; };
        const render = async (node: MarkdownNode): Promise<string> => {
            context.signal?.throwIfAborted();
            if (node.type === 'text') return escapeHtml(node.value);
            if (node.type === 'definition') return '';
            if (node.type === 'paragraph') {
                const embed = node.children?.length === 1 && node.children[0].type === 'text' ? parseEmbed(node.children[0].value || '') : null;
                if (embed) {
                    const key = documentId + ':' + occurrence++;
                    if (++embeddedCount > pdfExportLimits.views) throw new Fault(413, '单次导出最多支持 100 个嵌入块');
                    if (level > 0 || embed.kind === 'doc' && options.documentEmbeds === 'link') {
                        const target = tree[embed.target];
                        const valid = target?.kind === (embed.kind === 'doc' ? 'object' : 'view');
                        if (!valid) warn('embed', translated('嵌入目标不存在或不可访问', 'An embedded target is missing or unavailable'));
                        return `<p class="document-reference">${valid ? `<a href="${escapeHtml(link(target.id))}">${escapeHtml(target.title)}</a> · ${translated('仅保留引用', 'Reference only')}` : translated('嵌入目标不可用', 'Embedded target unavailable')}</p>`;
                    }
                    if (embed.kind === 'view') return renderView(embed.target, key);
                    const target = tree[embed.target];
                    const content = await renderDocument(embed.target, 1);
                    return `<section class="document-embed">${target?.kind === 'object' ? `<h2>${escapeHtml(target.title)}</h2>` : ''}${content}</section>`;
                }
                return `<p>${await children(node)}</p>`;
            }
            if (node.type === 'heading') {
                if (root.children?.[0] === node && text(node).trim() === document.title.trim()) return '';
                const depth = Math.min(6, (node.depth || 1) + level);
                const headingId = 'pdf-heading-' + (headings.length + 1);
                headings.push({ id: headingId, level: depth, title: text(node) });
                return `<h${depth} id="${headingId}">${await children(node)}</h${depth}>`;
            }
            if (node.type === 'image' || node.type === 'imageReference') {
                const source = node.url || definitions.get(node.identifier || '') || '';
                const image = await resolveImage(source);
                if (image.error || !image.source) { const message = image.error || translated('图片不可用', 'Image unavailable'); warn('image', message); return `<span class="unavailable">${translated('图片缺失', 'Missing image')}${node.alt ? ': ' + escapeHtml(node.alt) : ''} — ${escapeHtml(message)}</span>`; }
                return `<img src="${escapeHtml(image.source)}" alt="${escapeHtml(node.alt || '')}">`;
            }
            if (node.type === 'link' || node.type === 'linkReference') {
                const target = href(node.url || definitions.get(node.identifier || '') || '');
                const content = await children(node);
                return target ? `<a href="${escapeHtml(target)}">${content}</a>` : `<span>${content}</span>`;
            }
            if (node.type === 'inlineMath' || node.type === 'math') {
                try {
                    if ((node.value || '').length > mathPreviewLimits.sourceLength) throw Error('limit');
                    return katex.renderToString(node.value || '', { displayMode: node.type === 'math', throwOnError: true, trust: false, strict: 'ignore', maxExpand: mathPreviewLimits.maxExpand, maxSize: mathPreviewLimits.maxSize, output: 'htmlAndMathml' });
                } catch { const message = translated('公式无法渲染，保留源码', 'A formula could not be rendered; source retained'); warn('math', message); return `<code class="unavailable">${escapeHtml(node.value)}</code>`; }
            }
            if (node.type === 'code') return `<pre><code>${escapeHtml(node.value)}</code></pre>`;
            if (node.type === 'inlineCode') return `<code>${escapeHtml(node.value)}</code>`;
            if (node.type === 'html') {
                const value = node.value || '';
                if (/^(?:\s*<br\s*\/?>\s*)+$/i.test(value)) return value.replace(/\s*<br\s*\/?>\s*/gi, '<br>');
                return `<span>${escapeHtml(value)}</span>`;
            }
            if (node.type === 'thematicBreak') return '<hr>';
            if (node.type === 'break') return '<br>';
            if (node.type === 'list') { const tag = node.ordered ? 'ol' : 'ul'; return `<${tag}${node.ordered && node.start ? ` start="${node.start}"` : ''}>${await children(node)}</${tag}>`; }
            if (node.type === 'listItem') return `<li>${node.checked == null ? '' : node.checked ? '☑ ' : '☐ '}${await children(node)}</li>`;
            if (node.type === 'table') { const [first, ...rows] = node.children || []; const row = async (item: MarkdownNode, header: boolean) => { let cells = ''; for (const [index, cell] of (item.children || []).entries()) { const tag = header ? 'th' : 'td'; const alignment = node.align?.[index]; cells += `<${tag}${['left','center','right'].includes(alignment || '') ? ` style="text-align:${alignment}"` : ''}>${await children(cell)}</${tag}>`; } return '<tr>' + cells + '</tr>'; }; let body = ''; for (const item of rows) body += await row(item, false); return `<table>${first ? '<thead>' + await row(first, true) + '</thead>' : ''}<tbody>${body}</tbody></table>`; }
            const tags: Record<string, string> = { strong: 'strong', emphasis: 'em', delete: 'del', highlight: 'mark', blockquote: 'blockquote' };
            const tag = tags[node.type];
            return tag ? `<${tag}>${await children(node)}</${tag}>` : children(node);
        };
        return children(root);
    };
    const body = await renderDocument(id);
    const properties = options.properties ? Object.entries(entity.fields).map(([key, value]) => {
        const collection = entity.collection ? tree[entity.collection] : null;
        const field = collection?.kind === 'collection' ? collection.fields.find(field => field.key === key) : undefined;
        return `<div><dt>${escapeHtml(field?.label || key)}</dt><dd>${format(value, field)}</dd></div>`;
    }).join('') : '';
    const toc = options.toc && headings.length ? `<nav class="contents"><h2>${translated('目录', 'Contents')}</h2><ul>${headings.map(heading => `<li class="level-${heading.level}"><a href="#${heading.id}">${escapeHtml(heading.title)}</a></li>`).join('')}</ul></nav>` : '';
    const html = `<!doctype html><html lang="${options.language}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"><title>${escapeHtml(entity.title)}</title><style>${pdfPrintStyles(options)}</style></head><body><main><header class="document-title"><div class="project">${escapeHtml(context.project.name)}</div><h1>${escapeHtml(entity.title)}</h1><div class="snapshot">${escapeHtml(context.source)} · ${escapeHtml(date)} (${escapeHtml(context.timeZone)}) · ${escapeHtml(context.head.slice(0, 12))}</div></header>${properties ? '<dl class="properties">' + properties + '</dl>' : ''}${toc}${body}</main></body></html>`;
    if (Buffer.byteLength(html) > pdfExportLimits.htmlBytes + Math.ceil(pdfExportLimits.imageBytes * 4 / 3)) throw new Fault(413, '导出内容过大，请缩小文档或嵌入范围');
    return { html, inspection };
}

export function pdfPrintStyles(options: PdfOptions) {
    return `@page{size:${options.paper} ${options.orientation};margin:18mm 16mm 20mm}*{box-sizing:border-box}html{color-scheme:light}body{margin:0;color:#28372f;background:#fff;font:${options.fontSize}pt/1.65 "Microsoft YaHei","Noto Sans CJK SC","Noto Sans",Arial,sans-serif}h1,h2,h3,h4,h5,h6{line-height:1.35;break-after:avoid}h1{font-size:26pt;font-weight:600}h2{font-size:18pt;margin:9mm 0 4mm}h3{font-size:14pt;margin:6mm 0 3mm}h4{font-size:12pt;margin:0 0 3mm}p{margin:0 0 4mm;orphans:3;widows:3;white-space:pre-wrap;overflow-wrap:anywhere}a{color:#376548;text-decoration:none;overflow-wrap:anywhere}.project,.snapshot,.view-summary{color:#667460;font-size:9pt}.document-title{border-bottom:1px solid #dfe5d9;padding-bottom:5mm;margin-bottom:7mm}.document-title h1{margin:2mm 0 3mm}.contents{break-after:page}.contents ul{list-style:none;padding:0}.contents .level-3{padding-left:4mm}.contents .level-4,.contents .level-5,.contents .level-6{padding-left:8mm}table{width:100%;table-layout:fixed;border-collapse:collapse;margin:3mm 0 6mm;font-size:${Math.max(10, options.fontSize - 1)}pt}thead{display:table-header-group}th,td{text-align:left;border-bottom:1px solid #dfe5d9;padding:2.5mm;vertical-align:top;overflow-wrap:anywhere;white-space:pre-wrap}th{background:#edf2e8;font-weight:600}tr{break-inside:avoid}img{max-width:100%;max-height:210mm;object-fit:contain;break-inside:avoid}pre{background:#f4f5f0;padding:4mm;white-space:pre-wrap;overflow-wrap:anywhere;font-size:10pt}code{font-family:"Cascadia Code",Consolas,monospace;font-size:.9em}blockquote{border-left:2px solid #b9c6a8;padding-left:4mm;margin-left:0;color:#667460}mark{background:#e4edce}hr{border:0;border-top:1px solid #dfe5d9;margin:6mm 0}.export-view{margin:6mm 0}.export-view>header{break-after:avoid}.export-view h3{margin:0 0 2mm}.view-summary{margin-bottom:3mm}.records.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4mm 5mm;align-items:start}.record{break-inside:avoid;padding:4mm;margin:0 0 4mm;border:1px solid #dfe5d9}.records.cards .record{min-width:0;width:100%;margin:0}.records.list .record{border-width:0 0 1px;padding:3mm 0}.record dl,.properties{margin:0}dl>div{display:flex;gap:4mm;margin:1mm 0}dt{color:#667460;min-width:20mm;max-width:40%;overflow-wrap:anywhere}dd{margin:0;flex:1;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}.properties{padding:4mm;background:#f4f5f0;margin-bottom:6mm}.document-embed{border-left:2px solid #dfe5d9;padding-left:5mm;margin:6mm 0}.unavailable{display:block;border:1px dashed #b18b56;padding:3mm;color:#805d20;font-size:10pt}.empty,.document-reference{color:#667460;font-size:10pt}.katex-display{overflow-wrap:anywhere;break-inside:avoid}.katex{font-size:1.1em}`;
}
