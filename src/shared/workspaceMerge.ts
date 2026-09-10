import { z } from 'zod';
import { diff3Merge } from 'node-diff3';
import type { Tree } from './model.js';

export const mergeResolutionSchema = z.union([z.enum(['ours', 'theirs']), z.object({ value: z.json() })]);
export type MergeResolution = z.infer<typeof mergeResolutionSchema>;
export type MergeSegment = { text: string[] } | { base: string[]; ours: string[]; theirs: string[] };
export type MergeConflict = {
    path: string;
    title: string;
    file: string;
    property: string;
    label: string;
    base?: unknown;
    ours?: unknown;
    theirs?: unknown;
    segments?: MergeSegment[];
};

export function mergeConflicts(paths: string[], base: Tree, ours: Tree, theirs: Tree): MergeConflict[] {
    return paths.map(path => {
        const parts = path.split('/').slice(1);
        const read = (tree: Tree): unknown => parts.reduce<any>((value, key) => value?.[key], tree);
        const previous = read(base), left = read(ours), right = read(theirs);
        const entity = ours[parts[0]] || theirs[parts[0]] || base[parts[0]];
        const collection = entity.kind === 'object' && entity.collection ? ours[entity.collection] || theirs[entity.collection] || base[entity.collection] : undefined;
        const field = parts[1] === 'fields' && collection?.kind === 'collection' ? collection.fields.find(field => field.key === parts[2]) : undefined;
        const labels: Record<string, string> = { body: '正文', title: '标题', path: '路径', collection: '所属集合', fields: '字段' };
        const property = parts.slice(1).join('/') || '文件';
        const segments = parts.at(-1) === 'body' && typeof previous === 'string' && typeof left === 'string' && typeof right === 'string'
            ? diff3Merge(left.split('\n'), previous.split('\n'), right.split('\n')).map(region => region.ok
                ? { text: region.ok }
                : { base: region.conflict!.o, ours: region.conflict!.a, theirs: region.conflict!.b })
            : undefined;
        return { path, title: entity.title, file: entity.path, property, label: field?.label || labels[property] || property, base: previous, ours: left, theirs: right, segments };
    });
}

export function resolveSegments(segments: MergeSegment[], choices: Record<number, string[]>): string | undefined {
    if (segments.some((segment, index) => !('text' in segment) && !Object.hasOwn(choices, index))) return undefined;
    return segments.flatMap((segment, index) => 'text' in segment ? segment.text : choices[index]).join('\n');
}
