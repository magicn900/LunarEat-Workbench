import { afterAll, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { english } from '../src/web/locales/en.js';
import { setLanguage, t } from '../src/web/i18n.js';
import { reviewText } from '../src/web/reviewText.js';
vi.stubGlobal('document', { documentElement: { lang: 'zh-CN' } });
afterAll(() => { setLanguage('zh-CN'); vi.unstubAllGlobals(); });
it('所有显式中文翻译键都有英文条目', () => {
    const missing = new Set<string>();
    for (const file of readdirSync('src/web').filter(file => /\.tsx?$/.test(file))) {
        const source = ts.createSourceFile(file, readFileSync('src/web/' + file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && node.expression.getText(source) === 't' && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && /[\u3400-\u9fff]/.test(node.arguments[0].text) && typeof english[node.arguments[0].text] !== 'string') missing.add(node.arguments[0].text); ts.forEachChild(node, visit); };
        visit(source);
    }
    expect([...missing]).toEqual([]);
});
it('英文切换翻译界面词，不改写任意内容和自定义字段', () => {
    setLanguage('en'); expect(t('设置')).toBe('Settings'); expect(t(' 行附近')).toBe('');
    expect(reviewText('设置', 'body')).toBe('设置');
    expect(reviewText([{ key: 'custom', label: '深色', type: 'select', required: false, options: ['设置', '通用'] }], 'fields')).toContain('深色');
    expect(reviewText([{ key: 'custom', label: '深色', type: 'select', required: false, options: ['设置', '通用'] }], 'fields')).toContain('设置、通用');
    expect(reviewText('table', 'layout')).toBe('Table'); setLanguage('zh-CN'); expect(t('设置')).toBe('设置');
});

