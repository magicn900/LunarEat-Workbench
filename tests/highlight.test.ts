import { beforeAll, afterAll, expect, it } from 'vitest';
import { createCodec, type Codec } from '../src/server/codec';
let codec: Codec;
beforeAll(async () => { codec = await createCodec(); });
afterAll(async () => { await codec.close(); });
const markedText = (text: string, mark: string) => { const values: string[] = []; codec.parse(text).descendants(node => { if (node.isText && node.marks.some(item => item.type.name === mark)) values.push(node.text!); }); return values; };
it('高亮与删除线可嵌套格式并往返保存', () => {
    const text = '==强调== ~~删除~~ **==加粗高亮==** [==链接==](doc:overview)';
    expect(markedText(text, 'highlight')).toEqual(['强调', '加粗高亮', '链接']);
    expect(markedText(text, 'strike_through')).toEqual(['删除']);
    const serialized = codec.serialize(codec.parse(text));
    expect(markedText(serialized, 'highlight')).toEqual(['强调', '加粗高亮', '链接']);
    expect(markedText(serialized, 'strike_through')).toEqual(['删除']);
    expect(() => codec.schema.nodeFromJSON(codec.parse(serialized).toJSON())).not.toThrow();
});
it('代码及转义等号不被误识别成高亮', () => {
    const escape = String.fromCharCode(92);
    const text = '`==代码==` ' + escape + '==' + '原文' + escape + '==';
    expect(markedText(text, 'highlight')).toEqual([]);
    expect(markedText(codec.serialize(codec.parse(text)), 'highlight')).toEqual([]);
    const literal = codec.schema.node('doc', null, [codec.schema.node('paragraph', null, [codec.schema.text('==普通文字==')])]);
    expect(markedText(codec.serialize(literal), 'highlight')).toEqual([]);
});
