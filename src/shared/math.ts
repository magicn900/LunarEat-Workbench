import { $nodeSchema, $remark } from '@milkdown/utils';
import remarkMath from 'remark-math';
export const mathRemark = $remark('workbench-math', () => remarkMath);
export const mathSchemas = ['inline', 'block'].flatMap(kind => $nodeSchema('math_' + kind, () => ({
    group: kind === 'inline' ? 'inline' : 'block', inline: kind === 'inline',
    content: 'text*', marks: '', code: true, defining: true, isolating: true,
    parseDOM: [{ tag: '[data-math="' + kind + '"]', contentElement: '.math-source', preserveWhitespace: 'full' }],
    toDOM: () => [kind === 'inline' ? 'span' : 'div', { 'data-math': kind, class: 'math-node' }, ['span', { class: 'math-source' }, 0]],
    parseMarkdown: {
        match: node => node.type === (kind === 'inline' ? 'inlineMath' : 'math'),
        runner: (state, node, type) => { state.openNode(type); if (node.value && !(kind === 'inline' && node.value === ' ')) state.addText(String(node.value)); state.closeNode(); }
    },
    toMarkdown: {
        match: node => node.type.name === 'math_' + kind,
        runner: (state, node) => { state.addNode(kind === 'inline' ? 'inlineMath' : 'math', undefined, node.textContent || (kind === 'inline' ? ' ' : '')); }
    }
})));
export const isMath = (name: string) => name === 'math_inline' || name === 'math_block';
