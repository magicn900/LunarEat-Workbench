import { $markSchema, $remark } from '@milkdown/utils';
import type { Processor } from 'unified';
import { highlightMark } from 'micromark-extension-highlight-mark';
import { highlightMarkFromMarkdown, highlightMarkToMarkdown } from 'mdast-util-highlight-mark';

export function remarkHighlight(this: Processor) {
    const data = this.data();
    (data.micromarkExtensions ||= []).push(highlightMark());
    (data.fromMarkdownExtensions ||= []).push(highlightMarkFromMarkdown);
    (data.toMarkdownExtensions ||= []).push(highlightMarkToMarkdown);
}
export const highlightRemark = $remark('workbench-highlight', () => remarkHighlight);
export const highlightSchema = $markSchema('highlight', () => ({
    parseDOM: [{ tag: 'mark' }],
    toDOM: () => ['mark', 0],
    parseMarkdown: {
        match: node => node.type === 'highlight',
        runner: (state, node, markType) => { state.openMark(markType); state.next(node.children); state.closeMark(markType); }
    },
    toMarkdown: {
        match: mark => mark.type.name === 'highlight',
        runner: (state, mark) => { state.withMark(mark, 'highlight'); }
    }
}));
