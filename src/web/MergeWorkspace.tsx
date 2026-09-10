import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, GitMerge } from 'lucide-react';
import { mergeResolutionSchema, resolveSegments, type MergeConflict, type MergeResolution } from '../shared/workspaceMerge';
import type { ReviewItem } from '../shared/review';
import { api, notify, reload, useSnapshot } from './state';
import { flushEditing, locked } from './editing';
import { randomUUID } from './uuid';
import { Modal } from './Modal';
import { ReviewBrowser } from './ReviewBrowser';
import { t } from './i18n';
import './merge.css';

type Preview = { head: string; main: string; base: string; incoming: ReviewItem[]; conflictDetails: MergeConflict[] };
const printable = (value: unknown): string => value === undefined ? t('（不存在 / 已删除）') : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const agentPrompt = '请使用已安装的工作台协作 Skill，将团队最新正式设计合入我的个人草稿，不要发布或配置 MCP。按 references/publishing.md 的合并小节操作，仅补读冲突及决策所需的相关内容，不要重读无关全文。保留双方非冲突修改；业务意图不明确时先询问我，版本过期时重新核对，完成后释放写入控制权。';

function Comparison({ base, ours, theirs }: { base: unknown; ours: unknown; theirs: unknown }) {
    return <div className="merge-comparison">{[['共同基线', base], ['我的草稿', ours], ['最新正式设计', theirs]].map(([label, value]) => <section key={label as string}><h4>{t(label as string)}</h4><pre>{printable(value)}</pre></section>)}</div>;
}

function ConflictEditor({ conflict, disabled, onResolve }: { conflict: MergeConflict; disabled: boolean; onResolve: (value: MergeResolution | undefined) => void }) {
    const [chunks, setChunks] = useState<Record<number, string[]>>({});
    const [drafts, setDrafts] = useState<Record<number, string>>({});
    const [text, setText] = useState(conflict.ours === undefined ? '' : printable(conflict.ours)), [error, setError] = useState('');
    const [customReady, setCustomReady] = useState(conflict.ours !== undefined);
    const [choice, setChoice] = useState('');
    const updateChunk = (index: number, value?: string[]) => {
        const next = { ...chunks };
        if (value === undefined) delete next[index]; else next[index] = value;
        setChunks(next);
        const result = resolveSegments(conflict.segments!, next);
        onResolve(result === undefined ? undefined : { value: result });
    };
    const confirm = () => {
        try {
            const isText = [conflict.base, conflict.ours, conflict.theirs].every(value => value === undefined || typeof value === 'string');
            const result = mergeResolutionSchema.parse({ value: isText ? text : JSON.parse(text) });
            onResolve(result); setChoice('custom'); setError('');
        } catch { setError(t('请输入有效的 JSON 值')); }
    };
    return <div className="merge-conflict-editor">
        <header><h3>{conflict.title} · {t(conflict.label)}</h3><small>{conflict.file}</small></header>
        {conflict.segments ? <>
            <p className="muted">{t('非冲突内容已自动保留。逐块选择一方，或编辑结果并确认。')}</p>
            {conflict.segments.map((segment, index) => 'text' in segment ? <details className="merge-context" key={index}><summary>{t('已自动合并的上下文')} · {segment.text.length} {t('行')}</summary><pre>{segment.text.join('\n')}</pre></details> : <article className="merge-block" key={index}>
                <header><strong>{t('冲突块')} {conflict.segments!.slice(0, index + 1).filter(part => !('text' in part)).length}</strong><span>{Object.hasOwn(chunks, index) ? t('已解决') : t('待解决')}</span></header>
                <Comparison base={segment.base.join('\n')} ours={segment.ours.join('\n')} theirs={segment.theirs.join('\n')}/>
                <div className="merge-actions"><button disabled={disabled} onClick={() => { setDrafts({ ...drafts, [index]: segment.ours.join('\n') }); updateChunk(index, segment.ours); }}>{t('采用我的内容')}</button><button disabled={disabled} onClick={() => { setDrafts({ ...drafts, [index]: segment.theirs.join('\n') }); updateChunk(index, segment.theirs); }}>{t('采用正式内容')}</button></div>
                <label>{t('此块合并结果')}<textarea spellCheck={false} disabled={disabled} value={drafts[index] ?? segment.ours.join('\n')} onChange={event => { setDrafts({ ...drafts, [index]: event.target.value }); updateChunk(index); }}/></label>
                <button disabled={disabled || Object.hasOwn(chunks, index)} onClick={() => updateChunk(index, (drafts[index] ?? segment.ours.join('\n')).split('\n'))}>{Object.hasOwn(chunks, index) ? t('已确认此块') : t('确认此块')}</button>
            </article>)}
            {resolveSegments(conflict.segments, chunks) !== undefined && <details className="merge-context"><summary>{t('完整合并结果')}</summary><pre>{resolveSegments(conflict.segments, chunks)}</pre></details>}
        </> : <>
            <Comparison base={conflict.base} ours={conflict.ours} theirs={conflict.theirs}/>
            <div className="merge-actions"><button aria-pressed={choice === 'ours'} disabled={disabled} onClick={() => { setChoice('ours'); setText(conflict.ours === undefined ? '' : printable(conflict.ours)); setCustomReady(conflict.ours !== undefined); setError(''); onResolve('ours'); }}>{t('采用我的内容')}</button><button aria-pressed={choice === 'theirs'} disabled={disabled} onClick={() => { setChoice('theirs'); setText(conflict.theirs === undefined ? '' : printable(conflict.theirs)); setCustomReady(conflict.theirs !== undefined); setError(''); onResolve('theirs'); }}>{t('采用正式内容')}</button></div>
            <label>{t('自定义合并结果')}<small>{t('文本直接编辑；数字、数组和对象使用 JSON。选择已删除的一方会删除该内容。')}</small><textarea spellCheck={false} disabled={disabled} value={text} onChange={event => { setText(event.target.value); setCustomReady(true); setChoice(''); onResolve(undefined); }}/></label>
            {error && <p role="alert">{error}</p>}<button disabled={disabled || !customReady || choice === 'custom'} onClick={confirm}>{choice === 'custom' ? t('已确认结果') : t('确认自定义结果')}</button>
        </>}
    </div>;
}

export function MergeWorkspace({ onClose }: { onClose: () => void }) {
    const snapshot = useSnapshot();
    const [preview, setPreview] = useState<Preview | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
    const [resolutions, setResolutions] = useState<Record<string, MergeResolution>>({}), [selected, setSelected] = useState(''), [generation, setGeneration] = useState(0);
    const submission = useRef({ payload: '', requestId: '' });
    const load = async () => {
        setBusy(true); setError('');
        try { await flushEditing(); const next = await api('/publish/preview'); setPreview(next); setResolutions({}); setSelected(next.conflictDetails[0]?.path || ''); setGeneration(value => value + 1); }
        catch (failure: any) { setError(failure.message); }
        finally { setBusy(false); }
    };
    useEffect(() => { void load(); }, []);
    const stale = !!preview && (snapshot?.workspace.head !== preview.head || snapshot?.workspace.base !== preview.base || snapshot?.main !== preview.main);
    const disabled = busy || stale || locked() || !snapshot?.actor.scopes.includes('workspace.write');
    const unresolved = preview?.conflictDetails.filter(conflict => !resolutions[conflict.path]).length ?? 0;
    const merge = async () => {
        if (!preview) return;
        setBusy(true); setError('');
        try {
            await flushEditing();
            const payload = JSON.stringify({ head: preview.head, main: preview.main, resolutions });
            if (submission.current.payload !== payload) submission.current = { payload, requestId: randomUUID() };
            await api('/workspace/refresh', { ...JSON.parse(payload), requestId: submission.current.requestId });
            await reload(); notify(t('已合入最新正式设计，仅更新个人草稿')); onClose();
        } catch (failure: any) { setError(failure.message + (Array.isArray(failure.details) ? '：' + failure.details.join('；') : '')); }
        finally { setBusy(false); }
    };
    return <Modal title={t('合入最新正式设计')} className="merge-dialog" busy={busy} onClose={onClose}>
        <p className="merge-intro"><GitMerge size={20}/>{t('将团队正式版本合入我的草稿，保留个人修改。此操作不会发布。')}</p>
        {error && <p role="alert" className="error-list">{error}</p>}
        {stale && <p role="alert" className="release-warning">{t('草稿或正式版本已变化，当前结果不能提交。重新检查会清除本页选择。')}</p>}
        <div className="merge-overview"><strong>{preview ? unresolved ? t('待解决冲突') + ' · ' + unresolved : t('没有未解决冲突') : t('正在检查版本…')}</strong><button disabled={busy} onClick={() => void load()}>{t('重新检查版本')}</button></div>
        {preview && <>
            <div className="merge-versions"><span>{t('草稿基线')} <code>{preview.base.slice(0, 8)}</code></span><span>→</span><span>{t('最新正式设计')} <code>{preview.main.slice(0, 8)}</code></span></div>
            {preview.main === preview.base ? <p className="merge-success"><Check size={18}/>{t('已包含团队最新设计')}</p> : <>
                <details className="merge-incoming" open={!preview.conflictDetails.length}><summary>{t('正式版本更新内容')} · {preview.incoming.length}</summary>{preview.incoming.length ? <ReviewBrowser items={preview.incoming}/> : <p>{t('正式版本内容与基线一致，仅更新版本基线。')}</p>}</details>
                {!!preview.conflictDetails.length && <div className="merge-workspace"><nav aria-label={t('合并冲突列表')}>{preview.conflictDetails.map(conflict => <button key={conflict.path} aria-current={selected === conflict.path ? 'true' : undefined} onClick={() => setSelected(conflict.path)}>{resolutions[conflict.path] ? <Check size={16}/> : <AlertTriangle size={16}/>}<span><strong>{conflict.title}</strong><small>{t(conflict.label)}</small><small>{resolutions[conflict.path] ? t('已解决') : t('待解决')}</small></span></button>)}</nav><section className="merge-editors">{preview.conflictDetails.map(conflict => <div key={generation + conflict.path} hidden={selected !== conflict.path}><ConflictEditor conflict={conflict} disabled={disabled} onResolve={value => setResolutions(current => { const next = { ...current }; if (value === undefined) delete next[conflict.path]; else next[conflict.path] = value; return next; })}/></div>)}</section></div>}
            </>}
        </>}
        <aside className="merge-agent-tip"><strong>Tips · Agent</strong><p>{t('遇到难以机械合并的设计冲突，可让已连接项目的 Agent 对照基线和双方意图处理。不确定的业务取舍应先由你确认。Agent 修改后，请重新检查版本。')}</p><button onClick={async () => { try { await navigator.clipboard.writeText(t(agentPrompt)); notify(t('已复制 Agent 合并指令')); } catch { setError(t('复制失败，请手动复制指令')); } }}>{t('复制 Agent 合并指令')}</button><details><summary>{t('查看 Agent 指令')}</summary><p>{t(agentPrompt)}</p></details></aside>
        <footer className="merge-footer"><span>{t('仅更新个人草稿，不影响团队正式版本。')}</span><button disabled={busy} onClick={onClose}>{t('取消')}</button><button className="primary" disabled={disabled || !preview || preview.main === preview.base || unresolved > 0} onClick={() => void merge()}>{busy ? t('处理中…') : t('确认合并到我的草稿')}</button></footer>
    </Modal>;
}
