import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { preparePdfDocument, type PdfContext } from '../src/server/pdfDocument';
import { pdfOptionsSchema, pdfFilename, pdfSnapshotDate } from '../src/shared/pdfExport';
import type { CollectionView, Tree } from '../src/shared/model';

const context: PdfContext = { head: 'test-head', at: '2026-09-30T16:30:00.000Z', timeZone: 'Asia/Shanghai', project: { id: 'demo', name: '示例项目' }, origin: 'http://localhost', source: '个人草稿' };
function fixture(count = 34): Tree {
    const tree: Tree = {
        overview: { id: 'overview', kind: 'object', title: '示例文档', path: '示例.md', collection: null, fields: {}, body: '# 示例文档\n\n## 技能\n\n:::view[view]' },
        collection: { id: 'collection', kind: 'collection', title: '技能', path: '技能.json', fields: [{ key: 'cost', label: '消耗', type: 'number', required: false }, { key: 'hidden', label: '隐藏字段', type: 'text', required: false }] },
        view: { id: 'view', kind: 'view', title: '技能速览', path: 'view.json', collection: 'collection', columns: ['cost'], layout: 'table', filter: null, sort: { key: 'cost', descending: true }, pagination: { pageSize: 10 } }
    };
    for (let index = 0; index < count; index++) { const id = 'row-' + String(index).padStart(4, '0'); tree[id] = { id, kind: 'object', title: '记录 ' + index, path: id + '.md', collection: 'collection', fields: { cost: index, hidden: 'HIDDEN_VALUE' }, body: 'ROW_BODY_SHOULD_NOT_EXPORT' }; }
    return tree;
}
const options = (overrides = {}) => pdfOptionsSchema.parse(overrides);
const image = async () => ({ error: '图片不可用' });

describe('PDF 数据快照与打印模板', () => {
    it('HTML 换行标签与 Markdown 硬换行导出为真正换行，不显示标签文本', async () => {
        const tree = fixture(0);
        if (tree.overview.kind !== 'object') throw Error('fixture');
        tree.overview.body = '正文甲<br>正文乙<br/>正文丙<BR />正文丁\n\n<br />\n\n<br>\n<br />\n\n硬换行甲  \n硬换行乙\n\n反斜线甲\\\n反斜线乙';
        const output = await preparePdfDocument(tree, 'overview', context, options(), image);
        const document = new JSDOM(output.html).window.document;
        expect(document.querySelectorAll('main br')).toHaveLength(8);
        expect(document.querySelector('main')?.textContent).not.toMatch(/<br\s*\/?>/i);
        expect(document.querySelector('main p')?.innerHTML).toBe('正文甲<br>正文乙<br>正文丙<br>正文丁');
    });
    it('代码和转义文本中的换行标签原样显示，带属性的 HTML 不放行', async () => {
        const tree = fixture(0);
        if (tree.overview.kind !== 'object') throw Error('fixture');
        tree.overview.body = '`<br />`\n\n```html\n<br />\n```\n\n&lt;br /&gt;\n\n<br onclick="alert(1)">\n\n<script><br /></script>';
        const output = await preparePdfDocument(tree, 'overview', context, options(), image);
        const document = new JSDOM(output.html).window.document;
        expect(document.querySelector('p code')?.textContent).toBe('<br />');
        expect(document.querySelector('pre code')?.textContent).toBe('<br />');
        expect(document.querySelector('main')?.textContent).toContain('<br />');
        expect(document.querySelectorAll('main br, script, [onclick]')).toHaveLength(0);
    });
    it('保留可见字段与排序，忽略屏幕分页，名称始终保留，不展开记录正文', async () => {
        const output = await preparePdfDocument(fixture(), 'overview', context, options(), image);
        const document = new JSDOM(output.html).window.document;
        expect(output.inspection.views[0]).toMatchObject({ rows: 34, columns: 2, layout: 'table' });
        expect(document.querySelectorAll('.collection-table tbody tr')).toHaveLength(34);
        expect(document.querySelector('tbody tr td')?.textContent).toBe('记录 33');
        expect(output.html).not.toContain('HIDDEN_VALUE');
        expect(output.html).not.toContain('ROW_BODY_SHOULD_NOT_EXPORT');
        expect(document.querySelectorAll('h1')).toHaveLength(1);
    });
    it('搜索仅作用于可见字段，并与筛选取交集', async () => {
        const tree = fixture();
        const view = tree.view as CollectionView;
        view.filters = [{ key: 'cost', operator: 'gte', value: 20 }]; view.search = '3';
        const output = await preparePdfDocument(tree, 'overview', context, options(), image);
        expect(output.inspection.views[0].rows).toBe(5);
        expect(output.inspection.views[0].conditions).toContain('不小于 20');
        view.search = 'HIDDEN_VALUE';
        const empty = await preparePdfDocument(tree, 'overview', context, options(), image);
        expect(empty.inspection.views[0].rows).toBe(0);
        expect(empty.html).toContain('当前条件下没有记录');
    });
    it.each(['list', 'cards'] as const)('保留 %s 布局，可逐嵌入覆盖为表格或链接', async layout => {
        const tree = fixture(3); (tree.view as CollectionView).layout = layout;
        const original = await preparePdfDocument(tree, 'overview', context, options(), image);
        expect(original.html).toContain('records ' + layout);
        const table = await preparePdfDocument(tree, 'overview', context, options({ viewModes: { 'overview:0': 'table' } }), image);
        expect(new JSDOM(table.html).window.document.querySelectorAll('.collection-table tbody tr')).toHaveLength(3);
        const reference = await preparePdfDocument(tree, 'overview', context, options({ viewModes: { 'overview:0': 'link' } }), image);
        expect(reference.html).toContain('3 条匹配记录，未展开');
        expect(reference.html).not.toContain('记录 2');
        expect((tree.view as CollectionView).layout).toBe(layout);
    });
    it('超限不能静默截断，预检仍能列出数量并允许改为链接', async () => {
        const tree = fixture(2001);
        await expect(preparePdfDocument(tree, 'overview', context, options(), image)).rejects.toThrow('2000');
        const inspection = await preparePdfDocument(tree, 'overview', { ...context, inspectionOnly: true }, options(), image);
        expect(inspection.inspection.views[0].rows).toBe(2001);
        const reference = await preparePdfDocument(tree, 'overview', context, options({ viewModes: { 'overview:0': 'link' } }), image);
        expect(reference.inspection.views[0].rows).toBe(2001);
    });
    it('固定浏览器时区的相对日期查询，跨午夜不使用服务器业务日期', async () => {
        const tree = fixture(2), collection = tree.collection;
        if (collection.kind !== 'collection') throw Error('fixture');
        collection.fields.push({ key: 'date', label: '日期', type: 'date', required: false });
        (tree.view as CollectionView).filters = [{ key: 'date', operator: 'today' }];
        if (tree['row-0000'].kind === 'object') tree['row-0000'].fields.date = '2026-10-01';
        if (tree['row-0001'].kind === 'object') tree['row-0001'].fields.date = '2026-09-30';
        const output = await preparePdfDocument(tree, 'overview', context, options(), image);
        expect(output.inspection.views[0].rows).toBe(1);
        expect(output.html).toContain('记录 0'); expect(output.html).not.toContain('记录 1');
        expect(pdfSnapshotDate(context.at, context.timeZone)).toBe('2026-10-01');
    });
    it('一级嵌入不递归展开，缺失目标与图片留标记，原始 HTML 和危险链接不执行', async () => {
        const tree = fixture(1);
        tree.guide = { id: 'guide', kind: 'object', title: '关联文档', path: 'guide.md', collection: null, fields: {}, body: '关联正文\n\n:::doc[overview]\n\n:::view[view]' };
        if (tree.overview.kind === 'object') tree.overview.body = ':::doc[guide]\n\n:::doc[missing]\n\n![图](https://example.com/image.png)\n\n<script>alert(1)</script>\n\n[危险](javascript:alert(1))\n\n==高亮== 与 ~~删除~~\n\n$x^2$';
        const output = await preparePdfDocument(tree, 'overview', context, options(), image);
        const document = new JSDOM(output.html).window.document;
        expect(output.inspection.views).toHaveLength(0);
        expect(output.inspection.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'embed' }), expect.objectContaining({ kind: 'image' })]));
        expect(output.html).toContain('关联正文');
        expect(document.querySelector('script')).toBeNull();
        expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
        expect(document.querySelector('mark')?.textContent).toBe('高亮');
        expect(document.querySelector('del')?.textContent).toBe('删除');
        expect(document.querySelector('.katex')).not.toBeNull();
    });
    it('引用值显示标题、零值与否值保留、隐藏内部标识', async () => {
        const tree = fixture(1), collection = tree.collection;
        if (collection.kind !== 'collection' || tree['row-0000'].kind !== 'object') throw Error('fixture');
        collection.fields.push({ key: 'ref', label: '引用', type: 'reference', required: false }, { key: 'enabled', label: '启用', type: 'boolean', required: false });
        (tree.view as CollectionView).columns = ['cost', 'ref', 'enabled'];
        tree['row-0000'].fields = { cost: 0, ref: 'overview', enabled: false };
        const output = await preparePdfDocument(tree, 'overview', context, options(), image);
        const cells = [...new JSDOM(output.html).window.document.querySelectorAll('tbody td')].map(cell => cell.textContent);
        expect(cells).toEqual(['记录 0', '0', '示例文档', '否']);
        tree['row-0000'].fields.ref = 'SECRET_UNKNOWN_ID';
        const missing = await preparePdfDocument(tree, 'overview', context, options(), image);
        expect(missing.html).not.toContain('SECRET_UNKNOWN_ID');
        expect(missing.inspection.warnings.some(warning => warning.kind === 'field')).toBe(true);
    });
    it('重复嵌入可独立设置，目录只链接实际标题', async () => {
        const tree = fixture(2);
        if (tree.overview.kind === 'object') tree.overview.body += '\n\n:::view[view]';
        const output = await preparePdfDocument(tree, 'overview', context, options({ toc: true, viewModes: { 'overview:1': 'link' } }), image);
        expect(output.inspection.views.map(view => view.key)).toEqual(['overview:0', 'overview:1']);
        const document = new JSDOM(output.html).window.document;
        expect(document.querySelectorAll('.collection-table')).toHaveLength(1);
        expect(document.querySelector('.contents a')?.getAttribute('href')).toBe('#pdf-heading-1');
    });
    it('文件名清理路径和非法字符', () => { expect(pdfFilename('../设计:方案?')).toBe('.._设计_方案_.pdf'); expect(pdfFilename('   ')).toBe('document.pdf'); });
});
