import { t } from './i18n';
import 'katex/dist/katex.min.css';
import './math.css';
import { mathPreviewLimits, type MathPreviewResult as Result } from '../shared/mathLimits';
type Job = { id: number; source: string; display: boolean; done: (result: Result) => void };
const cache = new Map<string, Result>();
const queue: Job[] = [];
let worker: Worker | null = null, current: Job | null = null, timer: ReturnType<typeof setTimeout> | undefined, nextId = 0;
const key = (source: string, display: boolean) => Number(display) + ':' + source;
function finish(result: Result) {
    clearTimeout(timer);
    const job = current; current = null;
    if (job) {
        if (result.html && result.html.length < 100000) {
            cache.set(key(job.source, job.display), result);
            if (cache.size > 64) cache.delete(cache.keys().next().value!);
        }
        job.done(result);
    }
    runNext();
}
function fail() { worker?.terminate(); worker = null; finish({ error: t('公式预览不可用，源码仍会保存') }); }
function runNext() {
    if (current || !queue.length) return;
    current = queue.shift()!;
    try {
        if (!worker) {
            worker = new Worker(new URL('./math.worker.ts', import.meta.url), { type: 'module' });
            worker.onmessage = event => { if (event.data.id === current?.id) finish(event.data); };
            worker.onerror = event => { event.preventDefault(); fail(); };
        }
        timer = setTimeout(fail, mathPreviewLimits.timeoutMs);
        worker.postMessage({ id: current.id, source: current.source, display: current.display });
    } catch { fail(); }
}
export function renderMath(target: HTMLElement, source: string, display: boolean) {
    let live = true;
    target.classList.remove('math-error'); target.textContent = source || t('空公式');
    if (!source.trim()) { target.textContent = t('空公式'); target.removeAttribute('title'); return () => {}; }
    const done = (result: Result) => {
        if (!live) return;
        target.classList.toggle('math-error', !!result.error);
        if (result.html) { target.innerHTML = result.html; target.removeAttribute('title'); }
        else { target.textContent = source || t('空公式'); target.title = t('公式预览不可用，源码仍会保存') + ': ' + result.error; }
    };
    const cached = cache.get(key(source, display));
    let job: Job | undefined;
    if (cached) done(cached);
    else if (source.length > mathPreviewLimits.sourceLength || queue.length >= 128) done({ error: t('公式超过预览限制') });
    else { job = { id: ++nextId, source, display, done }; queue.push(job); runNext(); }
    return () => { live = false; if (job) { const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1); } };
}
export function renderDocumentMath(host: HTMLElement) {
    const cancellations: (() => void)[] = [];
    host.querySelectorAll<HTMLElement>('[data-math]').forEach(element => {
        const source = element.querySelector<HTMLElement>('.math-source');
        if (!source) return;
        const output = document.createElement('span'); output.className = 'math-rendered';
        element.append(output); source.hidden = true;
        cancellations.push(renderMath(output, source.textContent || '', element.dataset.math === 'block'));
    });
    return () => cancellations.forEach(cancel => cancel());
}
