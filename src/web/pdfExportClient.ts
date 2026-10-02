import { stable } from '../shared/model';
import { pdfExportLimits, pdfSnapshotDate, type PdfInspection, type PdfRequest, type PdfTaskStatus } from '../shared/pdfExport';
import { getSnapshot, subscribe } from './state';
import { t } from './i18n';

export type PdfResult = { identity: string; projectId: string; projectName: string; documentId: string; request: PdfRequest; inspection: PdfInspection; taskUrl: string; url: string; bytes: number; etag: string; savedAt: number; expiresAt: number; downloadUrl?: string };
let recent: PdfResult | null = null, expiry: ReturnType<typeof setTimeout> | undefined;

export function cancelPdfTask(taskUrl: string, projectId: string) {
    void fetch(taskUrl, { method: 'DELETE', headers: { 'x-workbench-client': 'web', 'x-project-id': projectId }, keepalive: true }).catch(() => {});
}
export function clearPdfResult() {
    clearTimeout(expiry);
    if (recent) { if (recent.downloadUrl) URL.revokeObjectURL(recent.downloadUrl); cancelPdfTask(recent.taskUrl, recent.projectId); }
    recent = null;
}
export function rememberPdfResult(result: PdfResult) {
    if (recent !== result) clearPdfResult();
    recent = result;
    clearTimeout(expiry); expiry = setTimeout(clearPdfResult, Math.max(0, Math.min(result.expiresAt, result.savedAt + 5 * 60000) - Date.now()));
}
export function matchingPdfResult(identity: string, projectId: string, projectName: string, documentId: string, request: PdfRequest) {
    if (!recent) return null;
    if (recent.identity !== identity || recent.projectId !== projectId || recent.projectName !== projectName || recent.documentId !== documentId || Math.min(recent.expiresAt, recent.savedAt + 5 * 60000) <= Date.now()) return null;
    const comparable = (input: PdfRequest) => stable({ ...input, at: undefined, date: input.at ? pdfSnapshotDate(input.at, input.timeZone) : '' });
    return comparable(recent.request) === comparable(request) ? recent : null;
}
export function samePdfInspection(left: PdfInspection, right: PdfInspection) { return stable({ ...left, at: undefined }) === stable({ ...right, at: undefined }); }
export function rememberPdfDownload(result: PdfResult, blob: Blob) {
    if (recent !== result || blob.size > pdfExportLimits.pdfBytes) return;
    if (result.downloadUrl) URL.revokeObjectURL(result.downloadUrl);
    result.downloadUrl = URL.createObjectURL(blob);
}
subscribe(() => {
    const snapshot = getSnapshot();
    if (recent && (!snapshot || snapshot.actor.userId !== recent.identity || snapshot.project.id !== recent.projectId || snapshot.workspace.head !== recent.request.head)) clearPdfResult();
});
if (typeof window !== 'undefined') window.addEventListener('identity-changed', clearPdfResult);

export async function pdfResponse(response: Response) {
    if (!response.ok) {
        const result = await response.json();
        throw Object.assign(new Error(t(result.error) + (result.requestId ? ' [' + result.requestId + ']' : '')), { status: response.status });
    }
    return response;
}
export async function pdfTaskStatus(taskUrl: string, signal: AbortSignal): Promise<PdfTaskStatus> {
    return (await pdfResponse(await fetch(taskUrl, { signal }))).json();
}
export function waitPdfTask(signal: AbortSignal, milliseconds = 600) {
    return new Promise<void>((resolve, reject) => {
        signal.throwIfAborted();
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
        signal.addEventListener('abort', abort, { once: true });
    });
}
export async function receivePdf(response: Response, expected: number, signal: AbortSignal, progress: (received: number, total: number) => void) {
    const total = Number(response.headers.get('content-length')) || expected;
    if (total > pdfExportLimits.pdfBytes || total !== expected) throw Error('PDF 文件大小已变化，请重新生成');
    const reader = response.body?.getReader();
    if (!reader) throw Error('PDF 文件传输不可用，请重试');
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let received = 0;
    const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
        signal.throwIfAborted();
        while (true) {
            const chunk = await reader.read(); signal.throwIfAborted();
            if (chunk.done) break;
            received += chunk.value.byteLength;
            if (received > pdfExportLimits.pdfBytes || received > total) throw Error('PDF 文件大小已变化，请重新生成');
            parts.push(chunk.value); progress(received, total);
        }
        if (received !== total) throw Error('PDF 文件传输不完整，请重试下载');
        return new Blob(parts, { type: 'application/pdf' });
    } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
