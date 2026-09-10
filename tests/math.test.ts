import { beforeAll, afterAll, expect, it } from 'vitest';
import { EditorState, TextSelection } from '@milkdown/prose/state';
import { createCodec, type Codec } from '../src/server/codec';
import { isMath } from '../src/shared/math';
let codec: Codec;
const slash = String.fromCharCode(92), newline = String.fromCharCode(10);
beforeAll(async () => { codec = await createCodec(); });
afterAll(async () => { await codec.close(); });
const formulas = (source: string) => { const values: { type: string; text: string }[] = []; codec.parse(source).descendants(node => { if (isMath(node.type.name)) values.push({ type: node.type.name, text: node.textContent }); }); return values; };
it('行内、独立和表格内公式保留源码并可往返', () => {
    const source = ['概率 $P(w_1), P(w_2)$', '', '$$', 'D = ' + slash + 'frac{a}{b}', '$$', '', '| 阶段 | 输出 |', '| --- | --- |', '| 训练 | $P(w)$ |'].join(newline);
    const parsed = codec.parse(source); parsed.check();
    expect(formulas(source)).toEqual([{ type: 'math_inline', text: 'P(w_1), P(w_2)' }, { type: 'math_block', text: 'D = ' + slash + 'frac{a}{b}' }, { type: 'math_inline', text: 'P(w)' }]);
    expect(formulas(codec.serialize(parsed))).toEqual(formulas(source));
});
it('不完整命令、危险命令和超长源码不阻断解析保存', () => {
    for (const text of [slash + 'frac{', slash + 'htmlClass{evil}{x}', slash + 'def' + slash + 'x{' + slash + 'x}' + slash + 'x', 'x'.repeat(13000)]) {
        const source = '$' + text + '$';
        expect(formulas(codec.serialize(codec.parse(source)))[0].text).toBe(text);
    }
});
it('代码、转义美元和没有闭合的美元符号不成为公式', () => {
    const tick = String.fromCharCode(96);
    const source = [tick + '$x$' + tick + ' ' + slash + '$20 单价 $30', '', tick.repeat(3) + 'latex', '$x$', tick.repeat(3)].join(newline);
    expect(formulas(source)).toEqual([]);
    expect(formulas(codec.serialize(codec.parse(source)))).toEqual([]);
});
it('公式节点内普通文本步骤可序列化，空节点可恢复', () => {
    const doc = codec.parse('前 $x$ 后');
    let position = 0; doc.descendants((node, offset) => { if (isMath(node.type.name)) position = offset; });
    const state = EditorState.create({ schema: codec.schema, doc, selection: TextSelection.create(doc, position + 1, position + 2) });
    const changed = state.apply(state.tr.insertText(slash + 'frac{'));
    expect(formulas(codec.serialize(changed.doc))[0].text).toBe(slash + 'frac{');
    const empty = changed.apply(changed.tr.delete(position + 1, position + 7));
    expect(formulas(codec.serialize(empty.doc))).toEqual([{ type: 'math_inline', text: '' }]);
});
it('文本中的美元标记经过序列化后不意外升级成公式', () => {
    const doc = codec.schema.node('doc', null, [codec.schema.node('paragraph', null, [codec.schema.text('$not math$')])]);
    expect(formulas(codec.serialize(doc))).toEqual([]);
});
