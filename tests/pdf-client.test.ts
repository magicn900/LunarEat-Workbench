import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ snapshot: null as null | { actor: { userId: string }; project: { id: string }; workspace: { head: string } }, listener: () => {} }));
vi.mock('../src/web/state', () => ({ getSnapshot: () => state.snapshot, subscribe: (listener: () => void) => { state.listener = listener; return () => {}; } }));
import { clearPdfResult, matchingPdfResult, receivePdf, rememberPdfDownload, rememberPdfResult, samePdfInspection, waitPdfTask, type PdfResult } from '../src/web/pdfExportClient';
import { pdfOptionsSchema, type PdfInspection } from '../src/shared/pdfExport';
afterEach(() => { clearPdfResult(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('reports received bytes and rejects an incomplete download', async () => {
    const bytes = new Uint8Array([37, 80, 68, 70, 45]), progress = vi.fn();
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 2)); controller.enqueue(bytes.subarray(2)); controller.close(); } }), { headers: { 'content-length': '5' } });
    const blob = await receivePdf(response, 5, new AbortController().signal, progress);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    expect(progress.mock.calls).toEqual([[2, 5], [5, 5]]);
    await expect(receivePdf(new Response(bytes.subarray(0, 2)), 5, new AbortController().signal, () => {})).rejects.toThrow('不完整');
});
it('cancels a pending stream and queue polling without retaining partial bytes', async () => {
    const controller = new AbortController(), cancelled = vi.fn();
    const pending = receivePdf(new Response(new ReadableStream({ cancel: cancelled })), 10, controller.signal, () => {});
    controller.abort(); await expect(pending).rejects.toThrow(); expect(cancelled).toHaveBeenCalledTimes(1);
    const polling = new AbortController(), waiting = waitPdfTask(polling.signal); polling.abort(); await expect(waiting).rejects.toThrow();
});
it('allows explicit timestamp-preserving reuse but not changed provenance or content warnings', () => {
    const report: PdfInspection = { title: 'Document', head: 'head', at: '2026-10-01T10:00:00.000Z', source: 'draft', views: [], warnings: [] };
    expect(samePdfInspection(report, { ...report, at: '2026-10-01T10:01:00.000Z' })).toBe(true);
    expect(samePdfInspection(report, { ...report, source: 'published' })).toBe(false);
    expect(samePdfInspection(report, { ...report, warnings: [{ kind: 'image', message: 'missing' }] })).toBe(false);
});

function cachedResult(): PdfResult {
    const at = '2026-10-01T10:00:00.000Z', inspection = { title: 'Document', head: 'head', at, source: 'draft', views: [], warnings: [] };
    return { identity: 'user', projectId: 'project', projectName: 'Project', documentId: 'doc', request: { head: 'head', at, timeZone: 'Asia/Shanghai', options: pdfOptionsSchema.parse({}) }, inspection, taskUrl: '/tasks/first', url: '/tasks/first/file', bytes: 5, etag: '"hash"', savedAt: Date.now(), expiresAt: Date.now() + 60000 };
}
it('matches identity, project, head, date, timezone and complete layout settings, and clears on identity/content changes', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const revoked = vi.spyOn(URL, 'revokeObjectURL'), result = cachedResult(); rememberPdfResult(result); rememberPdfDownload(result, new Blob(['%PDF-']));
    const match = (request = result.request) => matchingPdfResult('user', 'project', 'Project', 'doc', request);
    expect(match({ ...result.request, at: '2026-10-01T10:01:00.000Z' })).toBe(result);
    expect(match({ ...result.request, at: '2026-10-02T10:00:00.000Z' })).toBeNull();
    expect(match({ ...result.request, head: 'changed' })).toBeNull();
    expect(match({ ...result.request, timeZone: 'UTC' })).toBeNull();
    expect(match({ ...result.request, options: { ...result.request.options, paper: 'Letter' } })).toBeNull();
    expect(matchingPdfResult('other', 'project', 'Project', 'doc', result.request)).toBeNull();
    expect(matchingPdfResult('user', 'other', 'Project', 'doc', result.request)).toBeNull();
    state.snapshot = { actor: { userId: 'user' }, project: { id: 'project' }, workspace: { head: 'changed' } }; state.listener();
    expect(match()).toBeNull(); expect(revoked).toHaveBeenCalledWith(result.downloadUrl);
    rememberPdfResult(cachedResult()); state.snapshot = null; state.listener(); expect(match()).toBeNull();
});
it('retains only one result and revokes downloads when its bounded TTL expires', async () => {
    vi.useFakeTimers(); vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const revoked = vi.spyOn(URL, 'revokeObjectURL'), first = cachedResult(), second = { ...cachedResult(), taskUrl: '/tasks/second' };
    rememberPdfResult(first); rememberPdfDownload(first, new Blob(['%PDF-'])); rememberPdfResult(second);
    expect(revoked).toHaveBeenCalledWith(first.downloadUrl); expect(globalThis.fetch).toHaveBeenCalledWith(first.taskUrl, expect.objectContaining({ method: 'DELETE' }));
    await vi.advanceTimersByTimeAsync(60001);
    expect(matchingPdfResult('user', 'project', 'Project', 'doc', second.request)).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledWith(second.taskUrl, expect.objectContaining({ method: 'DELETE' }));
});
