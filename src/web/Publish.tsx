import { randomUUID } from './uuid';
import { t } from './i18n';
import { useEffect, useState } from 'react';
import { BookOpen, Check, FilePenLine, RotateCcw } from 'lucide-react';
import { api, notify, reload, useSnapshot } from './state';
import { flushEditing, locked } from './editing';
import { Modal } from './Modal';
import { DifferenceText, ReviewBrowser } from './ReviewBrowser';
import type { DiscardTarget } from '../shared/review';
export function Publish({ onClose }: { onClose: () => void }) {
    const snapshot = useSnapshot();
    const [preview, setPreview] = useState<any>(null), [title, setTitle] = useState(''), [description, setDescription] = useState(''), [choices, setChoices] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState(false), [error, setError] = useState(''), [plan, setPlan] = useState<any>(null), [undoGroup, setUndoGroup] = useState('');
    const load = async () => { const next = await api('/publish/preview'); setPreview(next); setChoices({}); };
    useEffect(() => { void api('/publish/preview').then(next => { setPreview(next); setTitle(next.publicationDraft?.title || ''); setDescription(next.publicationDraft?.description || ''); }).catch(error => setError(error.message)); }, []);
    const stale = preview && (snapshot?.workspace.head !== preview.head || snapshot?.workspace.base !== preview.base || snapshot?.main !== preview.main);
    const perform = async (action: () => Promise<void>) => { setBusy(true); setError(''); try { await action(); } catch (error: any) { setError(error.message + (Array.isArray(error.details) ? '：' + error.details.join('；') : '')); } finally { setBusy(false); } };
    const disabled = busy || locked();
    const inspectDiscard = (targets: DiscardTarget[]) => void perform(async () => { await flushEditing(); setPlan(await api('/workspace/discard-preview', { head: preview.head, base: preview.base, main: preview.main, targets })); });
    return <Modal title={t("发布正式设计")} onClose={onClose} className="release-dialog" busy={busy}>
        <div className="release-intro"><FilePenLine size={20}/><span>{t("整理我的草稿")}</span><span>→</span><BookOpen size={20}/><strong>{t("更新团队正式设计")}</strong></div>
        <p>{t("检查本次修改，丢弃不需要的部分，再发布剩余内容。发布后仍需跟进实现是否同步。")}</p>
        {error && <p role="alert" className="error-list">{t(error)}</p>}
        {!preview ? <button disabled={busy} onClick={() => void perform(load)}>{t("加载修改清单")}</button> : <>
            <div className="release-overview"><strong>{new Set(preview.review.map((item: any) => item.id)).size}{t("份内容 ·")} {preview.review.length}{t("处修改")}</strong><button disabled={disabled} onClick={() => void perform(load)}>{t("重新检查修改")}</button></div>
            {stale && <p role="alert" className="release-warning">{t("草稿或团队正式版本已更新，请重新检查修改后再操作。")}</p>}
            {undoGroup && <div className="release-undo"><Check size={15}/>{t("已丢弃所选修改，尚未影响正式设计。")}<button disabled={disabled} onClick={() => void perform(async () => { await flushEditing(); await api('/workspace/history-step', { requestId: randomUUID(), direction: 'undo', groupId: undoGroup }); await reload(); await load(); setUndoGroup(''); })}><RotateCcw size={14}/>{t("撤销刚才的丢弃")}</button></div>}
            <ReviewBrowser items={preview.review} discard={inspectDiscard} disabled={disabled || stale}/>
            {preview.main !== preview.base && <section className="release-update"><h3>{t("团队有新的正式版本")}</h3><p>{t("带入团队更新，同时保留我的修改。同一处有不同修改时，请选择要保留的内容。")}</p>{preview.conflicts.map((conflict: string) => <label key={conflict}>{conflict}<select aria-label={t("处理冲突 ") + conflict} disabled={disabled} value={choices[conflict] || ''} onChange={event => setChoices({ ...choices, [conflict]: event.target.value })}><option value="">{t("选择保留哪一份")}</option><option value="ours">{t("保留我的修改")}</option><option value="theirs">{t("采用团队正式设计")}</option></select></label>)}<button disabled={disabled || stale || preview.conflicts.some((key: string) => !choices[key])} onClick={() => void perform(async () => { await flushEditing(); await api('/workspace/refresh', { requestId: randomUUID(), head: preview.head, main: preview.main, resolutions: choices }); await reload(); await load(); })}>{t("更新我的草稿")}</button></section>}
            {preview.diagnostics.length > 0 && <section className="error-list" role="alert"><strong>{t("以下问题需要处理后才能发布")}</strong>{preview.diagnostics.map((issue: string) => <p key={issue}>{issue}</p>)}</section>}
            <details className="release-technical"><summary>{t("技术信息与原始文件")}</summary><p>{t("草稿起点")} <code>{preview.base}</code>{t("· 团队正式版")} <code>{preview.main}</code></p>{preview.raw.map((item: any) => <details key={item.id}><summary>{item.title}</summary><DifferenceText before={item.before} after={item.after}/></details>)}</details>
            <div className="release-description"><label>{t("变更标题")}<input value={title} disabled={disabled} onChange={event => setTitle(event.target.value)} placeholder={t("例如：调整技能消耗与释放规则")} maxLength={200}/></label><label>{t("变更说明")}<textarea value={description} disabled={disabled} onChange={event => setDescription(event.target.value)} placeholder={t("为什么修改？实现需要注意什么？")} maxLength={20000}/></label></div>
            <footer className="release-footer"><span>{t("草稿已自动保存；发布才会更新团队正式设计。")}</span><button className="primary" disabled={disabled || !snapshot?.actor.scopes.includes('design.publish') || stale || !title.trim() || !preview.review.length || !!preview.conflicts.length || !!preview.diagnostics.length} onClick={() => void perform(async () => { await flushEditing(); await api('/publish', { requestId: randomUUID(), head: preview.head, main: preview.main, title, description }); await reload(); notify(t("设计已发布 · 待同步至实现")); onClose(); })}>{busy ? t("处理中…") : t("发布为正式设计")}</button></footer>
        </>}
        {plan && <Modal title={t("丢弃这些草稿修改？")} className="discard-dialog" onClose={() => setPlan(null)} busy={busy}><p>{t("恢复到这份草稿的正式版本起点。不是暂时不发布，也不会删除正式设计的历史；误操作后可以撤销。")}</p>{plan.dependencies.length > 0 && <div className="release-warning"><strong>{t("以下关联内容也必须一起处理，请检查全部影响")}</strong>{plan.dependencies.map((item: any) => <p key={item.id}>{item.title}：{item.reason}</p>)}</div>}<ReviewBrowser items={plan.changes}/>{plan.issues.map((issue: string) => <p key={issue} className="error-list">{issue}</p>)}<footer className="release-footer"><button disabled={busy} onClick={() => setPlan(null)}>{t("保留修改")}</button><button className="danger" disabled={disabled || !!plan.issues.length} onClick={() => void perform(async () => { await flushEditing(); const result = await api('/workspace/discard', { requestId: randomUUID(), head: plan.head, base: plan.base, main: plan.main, targets: plan.targets }); setUndoGroup(result.groupId); setPlan(null); await reload(); await load(); })}>{t("确认丢弃")}{plan.dependencies.length ? t("及关联修改") : ''}</button></footer></Modal>}
    </Modal>;
}
