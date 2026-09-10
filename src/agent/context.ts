import { z } from 'zod';
import type { Service } from '../server/service.js';
import type { ReviewItem } from '../shared/review.js';

export const previewInput = {
    section: z.enum(['review','incoming','conflicts','diagnostics']).default('review'),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(20).default(10),
    maxBytes: z.number().int().min(2048).max(32768).default(12000),
    head: z.string().optional(), main: z.string().optional(), base: z.string().optional()
};
type Preview = ReturnType<Service['preview']>;
type PageInput = z.infer<z.ZodObject<typeof previewInput>>;
type Source = { revision: string } | { expectedHead: string };

function compactValue(value: unknown, id: string, location: string[], source: Source) {
    if (value === undefined) return { exists: false, complete: true };
    const complete = Buffer.byteLength(JSON.stringify(value)) <= 600;
    const field = location.length === 2 && location[0] === 'fields' ? location[1] : location.length === 1 && ['body','title','path'].includes(location[0]) ? location[0] : '$entity';
    return { exists: true, complete, ...(complete ? { value } : {}), ...(!complete ? { read: { ids: [id], field, ...source, offset: 0, length: 2000 }, valuePath: field === '$entity' ? location : [] } : {}) };
}

function compactChange(item: ReviewItem, before: Source, after: Source) {
    const location = item.property === '对象' ? [] : item.location;
    return { id: item.id, key: item.key, kind: item.kind, property: item.property, location, title: item.title.slice(0, 200), label: item.label.slice(0, 200), path: item.path.slice(0, 500), range: item.range, before: compactValue(item.before, item.id, location, before), after: compactValue(item.after, item.id, location, after) };
}

export function previewPage(preview: Preview, input: PageInput) {
    if (input.head && input.head !== preview.head || input.main && input.main !== preview.main || input.base && input.base !== preview.base)
        return { code: 'PREVIEW_CHANGED', error: '草稿或正式版本已变化，请重新预览，不要复用旧选择。' };
    const before = { revision: preview.base }, draft = { expectedHead: preview.head }, main = { revision: preview.main };
    const counts = { review: preview.review.length, incoming: preview.incoming.length, conflicts: preview.conflictDetails.length, diagnostics: preview.diagnostics.length };
    const key = input.section === 'conflicts' ? 'conflictDetails' : input.section;
    const metadata = { head: preview.head, main: preview.main, base: preview.base, section: input.section, counts };
    const list = input.section === 'conflicts' ? preview.conflictDetails : preview[input.section];
    const project = (item: unknown) => {
        if (input.section === 'diagnostics') return String(item);
        if (input.section !== 'conflicts') return compactChange(item as ReviewItem, before, input.section === 'incoming' ? main : draft);
        const conflict = item as Preview['conflictDetails'][number];
        const [id, ...location] = conflict.path.split('/').slice(1);
        const segmentsComplete = !!conflict.segments && Buffer.byteLength(JSON.stringify(conflict.segments)) <= 2000;
        return { path: conflict.path, title: conflict.title.slice(0, 200), file: conflict.file.slice(0, 500), label: conflict.label.slice(0, 200), base: compactValue(conflict.base, id, location, before), ours: compactValue(conflict.ours, id, location, draft), theirs: compactValue(conflict.theirs, id, location, main), ...(conflict.segments ? { segmentsComplete, ...(segmentsComplete ? { segments: conflict.segments } : {}) } : {}) };
    };
    if (input.offset > list.length) return { code: 'RANGE_INVALID', error: '分页起点超出结果范围。' };
    const selected: unknown[] = [];
    const result = (offset: number) => ({ ...metadata, [key]: selected, complete: offset >= list.length, next: offset >= list.length ? null : { ...input, offset, head: preview.head, main: preview.main, base: preview.base }, bounds: { limit: input.limit, maxBytes: input.maxBytes } });
    let offset = input.offset;
    while (offset < list.length && selected.length < input.limit) {
        selected.push(project(list[offset]));
        if (Buffer.byteLength(JSON.stringify(result(offset + 1))) > input.maxBytes) {
            selected.pop();
            if (!selected.length) return { code: 'RESULT_ITEM_TOO_LARGE', error: '单项超过响应预算，请增大 maxBytes；不要读取整个工作区。' };
            break;
        }
        offset++;
    }
    return result(offset);
}
