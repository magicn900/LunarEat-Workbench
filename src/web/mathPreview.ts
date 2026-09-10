import katex from 'katex';
import { mathPreviewLimits, type MathPreviewResult } from '../shared/mathLimits';
export function previewFormula(source: string, display: boolean): MathPreviewResult {
    try {
        if (source.length > mathPreviewLimits.sourceLength) throw Error('Formula exceeds preview limit');
        const html = katex.renderToString(source, { displayMode: display, throwOnError: true, trust: () => { throw Error('External resources and HTML are disabled'); }, strict: 'error', maxExpand: mathPreviewLimits.maxExpand, maxSize: mathPreviewLimits.maxSize, output: 'htmlAndMathml' });
        return { html };
    } catch (error) { return { error: String(error instanceof Error ? error.message : error).slice(0, 240) }; }
}
