import { z } from 'zod';

export const pdfViewModeSchema = z.enum(['original', 'table', 'link']);
export const pdfOptionsSchema = z.object({
    paper: z.enum(['A4', 'Letter']).default('A4'),
    orientation: z.enum(['portrait', 'landscape']).default('portrait'),
    fontSize: z.union([z.literal(11), z.literal(12), z.literal(14)]).default(12),
    toc: z.boolean().default(false),
    properties: z.boolean().default(false),
    pageNumbers: z.boolean().default(true),
    documentEmbeds: z.enum(['expand', 'link']).default('expand'),
    viewModes: z.record(z.string().max(200), pdfViewModeSchema).default({}).refine(value => Object.keys(value).length <= 100),
    allowIncomplete: z.boolean().default(false),
    language: z.enum(['zh-CN', 'en']).default('zh-CN')
});
export const pdfRequestSchema = z.object({
    head: z.string().min(1).max(100),
    at: z.string().datetime().optional(),
    timeZone: z.string().max(100).default('Asia/Shanghai').refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }),
    options: pdfOptionsSchema.default(() => pdfOptionsSchema.parse({}))
});
export type PdfOptions = z.infer<typeof pdfOptionsSchema>;
export type PdfRequest = z.infer<typeof pdfRequestSchema>;
export type PdfViewSummary = { key: string; id: string; title: string; layout: 'table' | 'list' | 'cards'; rows: number; columns: number; conditions: string; mode: z.infer<typeof pdfViewModeSchema>; available: boolean };
export type PdfWarning = { kind: 'image' | 'embed' | 'field' | 'math'; message: string };
export type PdfInspection = { title: string; head: string; at: string; source: string; views: PdfViewSummary[]; warnings: PdfWarning[] };
export const pdfExportLimits = { views: 100, rowsPerView: 2000, totalRows: 5000, imageBytes: 50 * 1024 * 1024, htmlBytes: 4 * 1024 * 1024, timeoutMs: 60000, pdfBytes: 30 * 1024 * 1024 } as const;
export function pdfFilename(title: string) { return (title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[.\s]+$/g, '').slice(0, 120) || 'document') + '.pdf'; }
export function pdfSnapshotDate(at: string, timeZone: string) { return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at)); }
