import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Download, FileText, LoaderCircle, RefreshCw, ExternalLink } from 'lucide-react';
import { Modal } from './Modal';
import { exportDocument } from './exportDocument';
import { flushEditing } from './editing';
import { getSnapshot, notify } from './state';
import { t, useLanguage } from './i18n';
import { pdfFilename, pdfOptionsSchema, type PdfOptions, type PdfInspection } from '../shared/pdfExport';
import './export.css';
const PdfPreview = lazy(() => import('./PdfPreview').then(module => ({ default: module.PdfPreview })));

function initialOptions(): PdfOptions {
    try { return pdfOptionsSchema.parse({ ...JSON.parse(localStorage.getItem('workbench-pdf-options') || '{}'), viewModes: {}, allowIncomplete: false }); }
    catch { return pdfOptionsSchema.parse({}); }
}

export function ExportMenu({ id }: { id: string }) {
    const [menu, setMenu] = useState(false), [dialog, setDialog] = useState(false);
    const host = useRef<HTMLSpanElement>(null);
    useEffect(() => {
        if (!menu) return;
        const close = (event: PointerEvent) => { if (!host.current?.contains(event.target as Node)) setMenu(false); };
        document.addEventListener('pointerdown', close);
        return () => document.removeEventListener('pointerdown', close);
    }, [menu]);
    const markdown = () => { setMenu(false); void exportDocument(id).catch(error => notify(error.message, true)); };
    return <span ref={host} className="export-menu" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setMenu(false); }} onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); setMenu(false); host.current?.querySelector<HTMLButtonElement>('[aria-haspopup]')?.focus(); }
        if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setMenu(true); requestAnimationFrame(() => { const buttons = [...(host.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]') || [])]; const index = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }); }
    }}><button onClick={markdown}><Download size={12}/>{t('导出')}</button><button aria-label={t('选择导出格式')} title={t('选择导出格式')} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><ChevronDown size={13}/></button>{menu && <span className="export-format-menu" role="menu" aria-label={t('导出格式')}><button role="menuitem" onClick={markdown}>{t('导出 Markdown')}</button><button role="menuitem" onClick={() => { setMenu(false); setDialog(true); }}>{t('导出 PDF…')}</button></span>}{dialog && <ExportDialog key={id} id={id} onClose={() => setDialog(false)}/>}</span>;
}

function ExportDialog({ id, onClose }: { id: string; onClose: () => void }) {
    const language = useLanguage();
    const [settings, setSettings] = useState(initialOptions);
    const options = useMemo(() => ({ ...settings, language }), [settings, language]);
    const projectId = useRef(getSnapshot()!.project.id).current;
    const identity = useRef(getSnapshot()!.actor.userId).current;
    const [captured, setCaptured] = useState<{ head: string; at: string } | null>(null);
    const [inspection, setInspection] = useState<PdfInspection | null>(null);
    const [filename, setFilename] = useState(getSnapshot()?.tree[id]?.title || 'document');
    const [stage, setStage] = useState<'saving' | 'checking' | 'generating' | 'ready' | 'warning' | 'error'>('saving');
    const [error, setError] = useState(''), [pdf, setPdf] = useState<string | null>(null), [attempt, setAttempt] = useState(0);
    const alive = useRef(true), controller = useRef<AbortController | null>(null), captureGeneration = useRef(0);
    useEffect(() => { alive.current = true; return () => { alive.current = false; captureGeneration.current++; controller.current?.abort(); }; }, []);
    useEffect(() => () => { if (pdf) URL.revokeObjectURL(pdf); }, [pdf]);
    const current = useCallback(() => { const snapshot = getSnapshot(); return snapshot?.project.id === projectId && snapshot.actor.userId === identity; }, [projectId, identity]);
    const capture = useCallback(async () => {
        const generation = ++captureGeneration.current;
        controller.current?.abort(); setCaptured(null); setPdf(null); setInspection(null); setError(''); setStage('saving');
        try {
            await flushEditing();
            if (!alive.current || captureGeneration.current !== generation) return;
            if (!current()) throw Error(t('项目已切换，请重新导出'));
            setSettings(previous => ({ ...previous, allowIncomplete: false }));
            setCaptured({ head: getSnapshot()!.workspace.head, at: new Date().toISOString() });
        } catch (failure: any) { if (alive.current && captureGeneration.current === generation) { setError(failure.message); setStage('error'); } }
    }, [current]);
    useEffect(() => { void capture(); }, [capture]);
    useEffect(() => {
        if (!captured) return;
        const abort = new AbortController(); controller.current = abort;
        setPdf(null); setError(''); setStage('checking');
        const headers = { 'content-type': 'application/json', 'x-workbench-client': 'web', 'x-project-id': projectId };
        const body = JSON.stringify({ ...captured, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, options });
        const endpoint = '/api/projects/' + encodeURIComponent(projectId) + '/documents/' + encodeURIComponent(id) + '/export-pdf';
        const request = async (path: string) => {
            if (!current()) throw Error(t('项目已切换，请重新导出'));
            const response = await fetch(path, { method: 'POST', headers, body, signal: abort.signal });
            if (!response.ok) { const result = await response.json(); throw Error(t(result.error) + (result.requestId ? ' [' + result.requestId + ']' : '')); }
            return response;
        };
        const timer = setTimeout(() => { void (async () => {
            try {
                const report: PdfInspection = await (await request(endpoint + '/inspect')).json();
                if (abort.signal.aborted || !alive.current) return;
                setInspection(report);
                if (report.warnings.length && !options.allowIncomplete) { setStage('warning'); return; }
                setStage('generating');
                const blob = await (await request(endpoint)).blob();
                if (abort.signal.aborted || !alive.current) return;
                if (!current()) throw Error(t('项目已切换，请重新导出'));
                setPdf(URL.createObjectURL(blob)); setStage('ready');
            } catch (failure: any) { if (!abort.signal.aborted && alive.current) { setError(failure.message); setStage('error'); } }
        })(); }, 400);
        return () => { clearTimeout(timer); abort.abort(); };
    }, [captured, options, attempt, current, id, projectId]);
    const change = <Key extends keyof PdfOptions>(key: Key, value: PdfOptions[Key]) => {
        setSettings(previous => {
            const next = { ...previous, [key]: value, allowIncomplete: key === 'allowIncomplete' ? Boolean(value) : false };
            try { const { viewModes, allowIncomplete, ...saved } = next; localStorage.setItem('workbench-pdf-options', JSON.stringify(saved)); } catch {}
            return next;
        });
    };
    const download = () => {
        if (!pdf || stage !== 'ready' || !filename.trim()) return;
        if (!current()) { setError(t('项目已切换，请重新导出')); setStage('error'); return; }
        const anchor = document.createElement('a'); anchor.href = pdf; anchor.download = pdfFilename(filename); anchor.click();
        notify(t('已下载预览中的同一份 PDF'));
    };
    const busy = ['saving', 'checking', 'generating'].includes(stage);
    const stages = { saving: t('正在确认编辑已保存…'), checking: t('正在检查文档与嵌入内容…'), generating: t('正在生成 PDF 预览…'), ready: t('预览与下载使用同一份文件'), warning: t('请确认不可用内容后继续'), error: t('生成失败，设置已保留') };
    return <Modal title={t('导出 PDF')} className="pdf-export-dialog" onClose={onClose}>
        <div className="pdf-export-context"><FileText size={15}/><span>{inspection?.title || getSnapshot()?.tree[id]?.title}</span><span>{inspection?.source || t('当前文档快照')}</span></div>
        <div className="pdf-export-body"><section className="pdf-export-settings" aria-label={t('PDF 排版设置')}>
            <label>{t('文件名')}<div className="pdf-filename"><input aria-label={t('PDF 文件名')} value={filename} maxLength={120} onChange={event => setFilename(event.target.value)}/><span>.pdf</span></div></label>
            <div className="pdf-setting-pair"><label>{t('纸张')}<select aria-label={t('纸张')} value={settings.paper} onChange={event => change('paper', event.target.value as PdfOptions['paper'])}><option>A4</option><option>Letter</option></select></label><label>{t('方向')}<select aria-label={t('方向')} value={settings.orientation} onChange={event => change('orientation', event.target.value as PdfOptions['orientation'])}><option value="portrait">{t('纵向')}</option><option value="landscape">{t('横向')}</option></select></label></div>
            <label>{t('正文字号')}<select value={settings.fontSize} onChange={event => change('fontSize', Number(event.target.value) as PdfOptions['fontSize'])}><option value={11}>{t('紧凑')} · 11 pt</option><option value={12}>{t('标准')} · 12 pt</option><option value={14}>{t('舒适')} · 14 pt</option></select></label>
            <label className="pdf-check"><input type="checkbox" checked={settings.toc} onChange={event => change('toc', event.target.checked)}/>{t('生成目录')}</label>
            <label className="pdf-check"><input type="checkbox" checked={settings.properties} onChange={event => change('properties', event.target.checked)}/>{t('包含文档属性')}</label>
            <label className="pdf-check"><input type="checkbox" checked={settings.pageNumbers} onChange={event => change('pageNumbers', event.target.checked)}/>{t('显示页码')}</label>
            <details><summary>{t('更多选项')}</summary><label>{t('嵌入文档')}<select value={settings.documentEmbeds} onChange={event => change('documentEmbeds', event.target.value as PdfOptions['documentEmbeds'])}><option value="expand">{t('展开一级内容')}</option><option value="link">{t('仅保留标题与链接')}</option></select></label><p>{t('导出不会发布文档，也不会修改原视图。')}</p></details>
            {!!inspection?.views.length && <details className="pdf-embedded-content"><summary>{t('文档中的集合视图')} · {inspection.views.length}</summary>{inspection.views.map(view => <label key={view.key}><strong>{view.title}</strong><span>{view.rows} {t('条匹配记录')} · {view.columns} {t('列')} · {t(view.layout === 'cards' ? '卡片' : view.layout === 'list' ? '列表' : '表格')}</span>{view.conditions && <small>{view.conditions}</small>}<select aria-label={view.title + ' ' + t('导出方式')} value={settings.viewModes[view.key] || 'original'} disabled={!view.available} onChange={event => change('viewModes', { ...settings.viewModes, [view.key]: event.target.value as PdfOptions['viewModes'][string] })}><option value="original">{t('跟随原布局')}</option><option value="table">{t('统一为表格')}</option><option value="link">{t('仅保留标题与链接')}</option></select>{view.rows > 2000 && <small className="error">{t('超过 2000 条，请仅保留链接或缩小筛选范围。')}</small>}</label>)}<p>{t('按筛选、搜索、排序及可见字段导出全部匹配记录，不受界面分页限制。')}</p></details>}
        </section><section className="pdf-export-preview" aria-label={t('PDF 预览')}><header><span>{t('PDF 预览')}</span><span>{settings.paper} · {t(settings.orientation === 'portrait' ? '纵向' : '横向')}</span>{pdf && <a href={pdf} target="_blank" rel="noreferrer"><ExternalLink size={13}/>{t('放大预览')}</a>}</header>{pdf ? <Suspense fallback={<div className="pdf-preview-placeholder"><LoaderCircle size={24} className="pdf-spinner"/>{t('正在载入 PDF 页面…')}</div>}><PdfPreview url={pdf}/></Suspense> : <div className="pdf-preview-placeholder">{busy ? <LoaderCircle size={28} className="pdf-spinner"/> : <FileText size={32}/>}<strong>{stages[stage]}</strong><span>{t('保留可复制文字、链接、图片与正文格式')}</span></div>}<p>{t('预览支持翻页与缩放；下载文件保留可复制文字和链接。')}</p></section></div>
        {inspection && <div className="pdf-export-snapshot">{inspection.source} · {new Date(inspection.at).toLocaleString(language)} · {inspection.head.slice(0, 12)}</div>}
        {!!inspection?.warnings.length && <div className="pdf-export-warning" role="alert"><strong>{t('部分内容无法完整导出')}</strong><ul>{inspection.warnings.map((warning, index) => <li key={index}>{warning.message}</li>)}</ul><label className="pdf-check"><input type="checkbox" checked={settings.allowIncomplete} onChange={event => change('allowIncomplete', event.target.checked)}/>{t('我已确认，带缺失标记继续')}</label></div>}
        {error && <div className="pdf-export-error" role="alert"><p>{error}</p><button onClick={() => void capture()}><RefreshCw size={14}/>{t('刷新快照并重试')}</button><button onClick={() => setAttempt(value => value + 1)}>{t('重试生成')}</button></div>}
        <div className="pdf-export-footer"><span role="status">{busy && <LoaderCircle size={13} className="pdf-spinner"/>}{stages[stage]}</span><div><button onClick={onClose}>{t(busy ? '取消生成' : '关闭')}</button><button className="primary" disabled={!pdf || stage !== 'ready' || !filename.trim()} onClick={download}><Download size={15}/>{t('下载 PDF')}</button></div></div>
    </Modal>;
}
