import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, LoaderCircle } from 'lucide-react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { t } from './i18n';

GlobalWorkerOptions.workerSrc = workerUrl;
export function PdfPreview({ url, onRendered }: { url: string; onRendered?: () => void }) {
    const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null), [pageNumber, setPageNumber] = useState(1), [zoom, setZoom] = useState('fit');
    const [error, setError] = useState(''), [rendering, setRendering] = useState(true), [width, setWidth] = useState(400);
    const canvas = useRef<HTMLCanvasElement>(null), viewport = useRef<HTMLDivElement>(null);
    const rendered = useRef(onRendered), firstFrame = useRef(false);
    rendered.current = onRendered;
    useEffect(() => {
        let active = true;
        setPdf(null); setPageNumber(1); setError(''); setRendering(true); firstFrame.current = false;
        const loading = getDocument({ url, withCredentials: true, rangeChunkSize: 256 * 1024, disableAutoFetch: true, disableStream: true });
        void loading.promise.then(document => { if (active) setPdf(document); }).catch(() => { if (active) { setError(t('预览渲染失败，可下载文件查看。')); setRendering(false); } });
        return () => { active = false; void loading.destroy().catch(() => {}); };
    }, [url]);
    useEffect(() => {
        const host = viewport.current;
        if (!host) return;
        const resize = new ResizeObserver(() => setWidth(host.clientWidth));
        resize.observe(host); setWidth(host.clientWidth);
        return () => resize.disconnect();
    }, []);
    useEffect(() => {
        if (!pdf || !canvas.current) return;
        let active = true, task: RenderTask | null = null;
        setRendering(true); setError('');
        void (async () => {
            try {
                const page = await pdf.getPage(pageNumber);
                if (!active || !canvas.current) return;
                const base = page.getViewport({ scale: 1 });
                const scale = zoom === 'fit' ? Math.min(Math.max(100, width - 24) / base.width, 510 / base.height) : Number(zoom);
                const size = page.getViewport({ scale });
                const target = canvas.current, drawing = target.getContext('2d');
                if (!drawing) throw Error('canvas');
                const density = Math.min(window.devicePixelRatio || 1, 2);
                target.width = Math.ceil(size.width * density); target.height = Math.ceil(size.height * density);
                target.style.width = Math.ceil(size.width) + 'px'; target.style.height = Math.ceil(size.height) + 'px';
                task = page.render({ canvas: target, canvasContext: drawing, viewport: size, transform: density === 1 ? undefined : [density, 0, 0, density, 0, 0] });
                await task.promise;
                if (active) { setRendering(false); if (!firstFrame.current) { firstFrame.current = true; rendered.current?.(); } }
            } catch (failure: any) { if (active && failure?.name !== 'RenderingCancelledException') { setError(t('预览渲染失败，可下载文件查看。')); setRendering(false); } }
        })();
        return () => { active = false; task?.cancel(); };
    }, [pdf, pageNumber, zoom, width]);
    return <div className="pdf-reader">
        <div className="pdf-reader-tools"><button aria-label={t('PDF 上一页')} disabled={!pdf || pageNumber <= 1} onClick={() => setPageNumber(value => value - 1)}><ChevronLeft size={15}/></button><span aria-label={t('PDF 页码')} role="status">{pageNumber} / {pdf?.numPages || '—'}</span><button aria-label={t('PDF 下一页')} disabled={!pdf || pageNumber >= pdf.numPages} onClick={() => setPageNumber(value => value + 1)}><ChevronRight size={15}/></button><select aria-label={t('PDF 缩放')} value={zoom} onChange={event => setZoom(event.target.value)}><option value="fit">{t('适合页面')}</option>{[0.5, 1, 1.5, 2].map(value => <option key={value} value={value}>{value * 100}%</option>)}</select></div>
        <div ref={viewport} className="pdf-reader-viewport" aria-busy={rendering}>
            {rendering && <div className="pdf-reader-loading" role="status"><LoaderCircle size={20} className="pdf-spinner"/>{t('正在绘制 PDF 预览…')}</div>}
            {error && <p role="alert">{error}</p>}
            <canvas ref={canvas} hidden={!!error || !pdf} role="img" aria-label={t('PDF 当前页') + ' ' + pageNumber} data-rendered={!rendering && !!pdf && !error}/>
        </div>
    </div>;
}
