import { expect, it } from 'vitest';
import { z } from 'zod';
import { previewInput, previewPage } from '../src/agent/context.js';
import { reviewChanges } from '../src/shared/review.js';
import { describeAgentCommand } from '../src/shared/agentContract.js';
import type { Service } from '../src/server/service.js';
import type { Tree } from '../src/shared/model.js';

function fixture() {
    const base: Tree = {}, ours: Tree = {};
    for (let index = 0; index < 30; index++) {
        const id = 'document-' + index;
        base[id] = { id, kind: 'object', title: id, path: id + '.md', collection: null, fields: { cost: 1 }, body: 'unrelated-long-body'.repeat(1000) };
        ours[id] = { ...base[id], fields: { cost: 2 } };
    }
    return { head: 'draft', main: 'main', base: 'base', ours, theirs: base, candidate: ours, review: reviewChanges(base, ours), incoming: [], conflictDetails: [], conflicts: [], diagnostics: [], raw: [], diff: [] } as unknown as ReturnType<Service['preview']>;
}
const page = (preview: ReturnType<Service['preview']>, input = {}) => previewPage(preview, z.object(previewInput).parse(input)) as any;

it('MCP preview bounds every page, excludes trees and preserves exact discard keys', () => {
    const preview = fixture();
    let result = page(preview, { maxBytes: 2048 });
    const keys: string[] = [];
    do {
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(2048);
        expect(result.code).toBeUndefined();
        expect(JSON.stringify(result)).not.toContain('unrelated-long-body');
        expect(result.ours).toBeUndefined();
        expect(result.candidate).toBeUndefined();
        keys.push(...result.review.map((item: any) => item.key));
        if (result.complete) break;
        expect(result.next).toMatchObject({ head: 'draft', main: 'main', base: 'base' });
        result = page(preview, result.next);
    } while (keys.length < 100);
    expect(keys).toEqual(preview.review.map(item => item.key));
    expect(result.complete).toBe(true);
});

it('MCP conflict values use version-checked range reads without leaking long segments', () => {
    const preview = fixture();
    const body = '长正文'.repeat(3000);
    preview.conflictDetails = [{ path: '/document-0/body', title: '文档', file: 'doc.md', property: 'body', label: '正文', base: body, ours: body + 'ours', theirs: body + 'theirs', segments: [{ text: [body] }] }];
    const result = page(preview, { section: 'conflicts' });
    const conflict = result.conflictDetails[0];
    expect(conflict.base).toMatchObject({ exists: true, complete: false, read: { revision: 'base', ids: ['document-0'], field: 'body' } });
    expect(conflict.ours.read.expectedHead).toBe('draft');
    expect(conflict.theirs.read.revision).toBe('main');
    expect(conflict.segmentsComplete).toBe(false);
    expect(conflict.segments).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(body);
    for (const version of ['head', 'main', 'base']) expect(page(preview, { [version]: 'stale' }).code).toBe('PREVIEW_CHANGED');
    expect(page(preview, { offset: 31 }).code).toBe('RANGE_INVALID');
});

it('action parents expose compact indexes while explicit full help preserves schemas', () => {
    for (const parent of ['versions', 'inspiration']) {
        const index = describeAgentCommand(parent) as any;
        const full = describeAgentCommand(parent + '.full') as any;
        expect(index.actionHelp).toContain(parent + (parent === 'versions' ? '.refresh' : '.find'));
        expect(index.fullHelp).toBe(parent + '.full');
        expect(index.input).toBeUndefined();
        expect(Buffer.byteLength(JSON.stringify(index))).toBeLessThan(Buffer.byteLength(JSON.stringify(full)) / 2);
    }
});
