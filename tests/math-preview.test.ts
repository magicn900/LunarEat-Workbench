import { expect, it } from 'vitest';
import { previewFormula } from '../src/web/mathPreview';
const slash = String.fromCharCode(92);
it('公式预览生成 HTML 与可访问 MathML', () => {
    const result = previewFormula(slash + 'frac{a}{b}', true);
    expect(result.error).toBeUndefined(); expect(result.html).toContain('katex-display'); expect(result.html).toContain('<math');
});
it('无效公式、循环宏、外部资源与 HTML 命令只能返回错误', () => {
    for (const source of [slash + 'frac{', slash + 'def' + slash + 'x{' + slash + 'x}' + slash + 'x', slash + 'href{javascript:alert(1)}{x}', slash + 'includegraphics{https://invalid.test/a.png}', slash + 'htmlClass{evil}{x}', 'x'.repeat(12001)]) {
        const result = previewFormula(source, false); expect(result.error, source.slice(0, 50)).toBeTruthy(); expect(result.html).toBeUndefined();
    }
});
it('宏定义不会跨公式泄漏', () => {
    expect(previewFormula(slash + 'gdef' + slash + 'workbenchtest{1}' + slash + 'workbenchtest', false).html).toBeTruthy();
    expect(previewFormula(slash + 'workbenchtest', false).error).toBeTruthy();
});
