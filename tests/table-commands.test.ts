import { beforeAll, afterAll, expect, it } from 'vitest';
import { EditorState, TextSelection } from '@milkdown/prose/state';
import { createCodec } from '../src/server/codec';
import { insertMarkdownTable, tableCommand, tableContext } from '../src/web/tableCommands';

let codec: Awaited<ReturnType<typeof createCodec>>;
beforeAll(async () => { codec = await createCodec(); });
afterAll(async () => { await codec.close(); });
function setup(row = 1, column = 0) {
    const doc = codec.parse(['| 标题 A | 标题 B |', '| --- | --- |', '| 甲 | 乙 |', '| 丙 | 丁 |'].join(String.fromCharCode(10)));
    const state = EditorState.create({ doc, schema: codec.schema });
    let position = 1;
    for (let index = 0; index < row; index++) position += doc.firstChild!.child(index).nodeSize;
    position++;
    for (let index = 0; index < column; index++) position += doc.firstChild!.child(row).child(index).nodeSize;
    return state.apply(state.tr.setSelection(TextSelection.create(doc, position + 2)));
}
function run(state: EditorState, command: string) {
    let next = state;
    expect(tableCommand(command)(state, transaction => { next = state.apply(transaction); })).toBe(true);
    next.doc.check();
    expect(codec.parse(codec.serialize(next.doc)).textContent).toBe(next.doc.textContent);
    return next;
}
it('插入合法的三列 Markdown 表格并定位首格', () => {
    let state = EditorState.create({ doc: codec.parse(''), schema: codec.schema });
    insertMarkdownTable(state, transaction => { state = state.apply(transaction); });
    state.doc.check();
    expect(tableContext(state)).toMatchObject({ rows: 3, columns: 3, row: 0, column: 0 });
});
it('行列增删、移动保持表头和 Markdown 往返内容', () => {
    expect(run(setup(), 'row-after').doc.firstChild!.childCount).toBe(4);
    expect(run(setup(), 'row-before').doc.firstChild!.childCount).toBe(4);
    expect(run(setup(), 'row-delete').doc.firstChild!.childCount).toBe(2);
    expect(run(setup(), 'row-down').doc.firstChild!.child(1).textContent).toBe('丙丁');
    expect(run(setup(2), 'row-up').doc.firstChild!.child(1).textContent).toBe('丙丁');
    expect(run(setup(), 'column-before').doc.firstChild!.firstChild!.childCount).toBe(3);
    expect(run(setup(), 'column-after').doc.firstChild!.firstChild!.childCount).toBe(3);
    expect(run(setup(), 'column-append').doc.firstChild!.firstChild!.childCount).toBe(3);
    expect(run(setup(), 'column-delete').doc.firstChild!.firstChild!.childCount).toBe(1);
    expect(run(setup(), 'column-right').doc.firstChild!.firstChild!.firstChild!.textContent).toBe('标题 B');
});
it('表头和最后一行、最后一列不能被行列操作误删', () => {
    expect(tableCommand('row-delete')(setup(0))).toBe(false);
    expect(tableCommand('row-before')(setup(0))).toBe(false);
    expect(tableCommand('row-up')(setup())).toBe(false);
    expect(tableCommand('row-delete')(run(setup(), 'row-delete'))).toBe(false);
    expect(tableCommand('column-delete')(run(setup(), 'column-delete'))).toBe(false);
});
it('对齐更新整列并保存到 Markdown，末格 Tab 新增行', () => {
    const centered = run(setup(), 'align-center');
    centered.doc.firstChild!.forEach(row => expect(row.firstChild!.attrs.alignment).toBe('center'));
    expect(codec.serialize(centered.doc)).toMatch(/:-+:/);
    expect(tableContext(run(setup(2, 1), 'cell-next'))).toMatchObject({ row: 3, column: 0, rows: 4 });
});
