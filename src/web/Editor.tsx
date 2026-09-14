import { mathRemark, mathSchemas } from '../shared/math';
import { mathEditingPlugin } from './mathEditing';
import { randomUUID } from './uuid';
import { t } from './i18n';
import { Component, useCallback, useEffect, useRef, useState, useMemo, type ReactNode } from 'react';
import { MarkdownEditor } from './MarkdownEditor';
import { DocumentBackup } from './DocumentBackup';
import { documentDelta } from './documentSync';
import './markdown-source.css';
import { EditorTools } from './EditorTools';
import { EditorToolsController } from './editorCommands';
import { createEmbedNodeView } from './EmbeddedBlock';
import { embedSchema, embedRemark, documentSchemaVersion } from '../shared/embeds';
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, serializerCtx, parserCtx, schemaCtx } from '@milkdown/core';
import { commonmark, strongKeymap, emphasisKeymap } from '@milkdown/preset-commonmark';
import { gfm, strikethroughKeymap } from '@milkdown/preset-gfm';
import { highlightRemark, highlightSchema } from '../shared/highlight';
import type { MilkdownPlugin } from '@milkdown/ctx';
import { locked, registerBuffer, editingChanged, flushEditing } from './editing';
import { $prose } from '@milkdown/utils';
import { Plugin, TextSelection } from '@milkdown/prose/state';

import { Step } from '@milkdown/prose/transform';
import { collab, sendableSteps, getVersion, receiveTransaction } from 'prosemirror-collab';
import { api, getSnapshot, subscribe, notify, navigate } from './state';


class DocumentBoundary extends Component<{ children: ReactNode; onFailure: (reason: string) => void }, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    componentDidCatch(error: Error) { this.props.onFailure(error.message); }
    render() { return this.state.failed ? null : this.props.children; }
}
export function DocumentEditor(props: { id: string; onStatus: (status: string) => void; heading: ReactNode }) {
    return <RecoverableDocument key={props.id} {...props}/>;
}
function RecoverableDocument(props: { id: string; onStatus: (status: string) => void; heading: ReactNode }) {
    const [source, setSource] = useState(false), [reason, setReason] = useState('');
    const failed = useCallback((message: string) => { setReason(message); setSource(true); }, []);
    if (source) return <div className="document-surface"><div className="document-scroll">{props.heading}<MarkdownEditor id={props.id} reason={reason} onClose={() => { setReason(''); setSource(false); }}/></div></div>;
    return <><div className="document-source-switch"><button onClick={() => void flushEditing().then(() => setSource(true)).catch((error: Error) => notify(error.message, true))}>{t('编辑 Markdown 源码')}</button></div><DocumentBoundary onFailure={failed}><RichDocumentEditor {...props} onFailure={failed}/></DocumentBoundary></>;
}
function RichDocumentEditor({ id, onStatus, heading, onFailure }: {
    id: string;
    onStatus: (status: string) => void;
    heading: ReactNode;
    onFailure: (reason: string) => void;
}) {
    const host = useRef<HTMLDivElement>(null);
    const tools = useMemo(() => new EditorToolsController(id), [id]);
    const [recovery, setRecovery] = useState('');
    const [syncNotice, setSyncNotice] = useState('');
    const retrySync = useRef(() => {}), downloadCurrent = useRef(() => {});
    const [finding,setFinding]=useState(false),[findText,setFindText]=useState(''),[findCount,setFindCount]=useState('');
    const recoveryRef = useRef(recovery);
    recoveryRef.current = recovery;
    const onStatusRef = useRef(onStatus);
    onStatusRef.current = onStatus;
    useEffect(() => {
        let disposed = false, blocked = false, editor: Editor | undefined, sending = false, pulling = false, unsubscribe = () => { }, retry: ReturnType<typeof setTimeout> | undefined;
        let batchSignature = '', batchRequestId = '';
        const clientId = randomUUID(), recoveryKey = 'draft:' + getSnapshot()?.actor.userId + ':' + id;
        let groupId = 'human:' + randomUUID(), lastBatch = 0, splitGroup = false;
        tools.onCommand = () => { splitGroup = true; };
        const saved = localStorage.getItem(recoveryKey);
        if (saved)
            setRecovery(saved);
        const backup = new DocumentBackup(recoveryKey, doc => editor!.action(ctx => ctx.get(serializerCtx)(doc)), () => onStatusRef.current('无法生成恢复副本，请保留当前页面'));
        const keep = () => { if (editor) try { backup.schedule(editor.action(ctx => ctx.get(editorViewCtx).state.doc)); backup.flush(); } catch { onStatusRef.current('无法生成恢复副本，请保留当前页面'); } };
        const fallback = (error: any) => { if (disposed) return; blocked = true; keep(); onStatusRef.current('已切换 Markdown 源码'); onFailure(error.message || '富文本不可用'); };
        const pause = (message: string) => {
            if (disposed) return;
            blocked = true;
            keep();
            setSyncNotice(message);
            onStatusRef.current('同步暂停 · 当前输入已保留，请勿关闭页面');
            editingChanged();
        };
        const consume = (remote: any) => {
            if (remote.schemaVersion !== documentSchemaVersion) { pause(t("编辑器协议已更新，请保存恢复副本并刷新页面")); return; }
            if (!editor || disposed || editor.action(ctx => ctx.get(editorViewCtx).composing))
                return;
            editor.action(ctx => {
                const view = ctx.get(editorViewCtx);
                const version = getVersion(view.state);
                const delta = documentDelta(version, remote);
                if (delta.kind === 'stale') return;
                if (delta.kind === 'gap') {
                    pause(t('同步记录暂时无法衔接，当前正文保持不变。可以继续输入、重试同步或下载正文；请勿关闭页面。'));
                    return;
                }
                if (delta.clientIds.some(remoteId => remoteId !== clientId)) splitGroup = true;
                const before = sendableSteps(view.state)?.steps.length || 0;
                if (before && delta.clientIds.some(remoteId => remoteId !== clientId)) keep();
                const transaction = receiveTransaction(view.state, delta.steps.map((step: any) => Step.fromJSON(view.state.schema, step)), delta.clientIds);
                const after = sendableSteps(view.state.apply(transaction))?.steps.length || 0;
                const acknowledged = delta.clientIds.filter(remoteId => remoteId === clientId).length;
                if (after < before - acknowledged) {
                    pause(t('另一处修改与当前输入冲突，已暂停同步并保留当前正文，不会自动覆盖任一版本。请下载正文备份。'));
                    return;
                }
                blocked = false;
                setSyncNotice('');
                view.dispatch(transaction);
            });
        };
        const pull = async () => { if (pulling || !editor || disposed || editor.action(ctx => ctx.get(editorViewCtx).composing))
            return; pulling = true; try {
            const version = editor.action(ctx => getVersion(ctx.get(editorViewCtx).state));
            consume(await api('/documents/' + id + '?since=' + version));
        }
        catch (error: any) {
            pause(error.message || t('连接中断 · 输入已保留'));
            if (!error.status || error.status >= 500) {
                clearTimeout(retry);
                retry = setTimeout(() => retrySync.current(), 1500);
            }
        }
        finally {
            pulling = false;
        } };
        const pump = async () => {
            if (!editor || disposed || sending || blocked || editor.action(ctx => ctx.get(editorViewCtx).composing))
                return;
            const pending = editor.action(ctx => sendableSteps(ctx.get(editorViewCtx).state));
            if (!pending) {
                if(!recoveryRef.current) backup.clear();
                setSyncNotice('');
                onStatusRef.current('已保存');
                return;
            }
            sending = true;
            onStatusRef.current('保存中');
            const signature = JSON.stringify({ version: pending.version, steps: pending.steps.map(step => step.toJSON()) });
            if (signature !== batchSignature) {
                batchSignature = signature;
                batchRequestId = randomUUID();
                if (splitGroup || Date.now()-lastBatch > 750) groupId = 'human:' + randomUUID();
                lastBatch=Date.now(); splitGroup=false;
            }
            try {
                const result = await api('/documents/' + id + '/steps', { requestId: batchRequestId, schemaVersion: documentSchemaVersion, version: pending.version, steps: pending.steps.map(step => step.toJSON()), clientId, groupId });
                if (disposed) return;
                consume(result.document);
                if (!blocked && !recoveryRef.current && !editor.action(ctx => sendableSteps(ctx.get(editorViewCtx).state)))
                    backup.clear();
            }
            catch (error: any) {
                if (disposed) return;
                keep();
                if (error.code === 'DOCUMENT_RENDER_FAILED' || error.code === 'DOCUMENT_SCHEMA_CHANGED' || error instanceof RangeError) { pause(error.message); return; }
                if (error.status === 409) {
                    await pull();
                    if (!blocked && editor.action(ctx => getVersion(ctx.get(editorViewCtx).state)) === pending.version) pause(error.message);
                }
                else if (error.status >= 400 && error.status < 500) {
                    pause(error.message);
                    return;
                }
                else {
                    pause(t('连接暂时中断，当前正文保持不变，正在自动重试。可以继续输入，请勿关闭页面。'));
                    clearTimeout(retry);
                    retry = setTimeout(() => retrySync.current(), 1500);
                    return;
                }
            }
            finally {
                sending = false;
                editingChanged();
            }
            if (!disposed)
                queueMicrotask(() => void pump());
        };
        retrySync.current = () => {
            if (disposed) return;
            clearTimeout(retry);
            if (pulling || sending) { retry = setTimeout(() => retrySync.current(), 1500); return; }
            blocked = false;
            void pull().then(() => { if (!blocked) void pump(); });
        };
        downloadCurrent.current = () => {
            if (!editor || disposed) return;
            keep();
            const body = editor.action(ctx => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc));
            const url = URL.createObjectURL(new Blob([body], { type: 'text/markdown;charset=utf-8' }));
            const anchor = document.createElement('a'); anchor.href = url; anchor.download = id + '.md'; anchor.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        };
        const widgets = $prose(ctx => new Plugin({ props: { nodeViews: { workbench_embed: createEmbedNodeView(tools, text => ctx.get(parserCtx)(text), ctx.get(schemaCtx)) }, handleClick(view, pos, event) { const link = (event.target as HTMLElement).closest('a'); if (!link)
                    return false; const mark = view.state.doc.nodeAt(pos)?.marks.find(mark => mark.type.name === 'link') || view.state.doc.resolve(pos).marks().find(mark => mark.type.name === 'link'); const href = mark?.attrs.href || link.getAttribute('href') || ''; if (href.startsWith('doc:')) {
                    event.preventDefault();
                    navigate(href.slice(4));
                    return true;
                } if (!/^(https?:|mailto:)/.test(href)) {
                    event.preventDefault();
                    return true;
                } return false; } } }));
        void (async () => {
            try {
                const initial = await api('/documents/' + id);
                if (initial.schemaVersion !== documentSchemaVersion) throw Error(t("服务端编辑器协议未更新，请重启服务并刷新页面"));
                if (disposed)
                    return;
                const replacedKeymaps = new Set<MilkdownPlugin>([...strongKeymap, ...emphasisKeymap, ...strikethroughKeymap]);
                editor = await Editor.make().config(ctx => { ctx.set(rootCtx, host.current); ctx.set(defaultValueCtx, { type: 'json', value: initial.doc }); }).use(commonmark.filter(plugin => !replacedKeymaps.has(plugin))).use(gfm.filter(plugin => !replacedKeymaps.has(plugin))).use(embedRemark).use(embedSchema).use(highlightRemark).use(highlightSchema).use(mathRemark).use(mathSchemas).use($prose(ctx => mathEditingPlugin(text => ctx.get(parserCtx)(text)))).use($prose(() => tools.plugin)).use($prose(() => tools.images.plugin)).use($prose(() => collab({ version: initial.version, clientID: clientId }))).use(widgets).use($prose(() => new Plugin({ props: { editable: () => !locked() }, view: () => ({ update(view, previous) { if (editor && view.state.doc !== previous.doc) {
                            if (sendableSteps(view.state)) backup.schedule(view.state.doc);
                            queueMicrotask(() => void pump());
                        } } }) }))).create();
                if (disposed) {
                    await editor.destroy();
                    return;
                }
                if (saved) {
                    try {
                        const alreadySaved = editor.action(ctx => ctx.get(parserCtx)(saved).eq(ctx.get(editorViewCtx).state.doc));
                        if (alreadySaved) { backup.clear(); recoveryRef.current = ''; setRecovery(''); }
                    } catch { }
                }
                unsubscribe = subscribe(() => { editor?.action(ctx=>ctx.get(editorViewCtx).setProps({editable:()=>!locked()})); void pull(); });
                onStatusRef.current('已保存');
                await pull();
            }
            catch (error: any) {
                notify(error.message, true);
                fallback(error);
            }
        })();
        let findIndex=-1, lastQuery='';
        const openFind=()=>setFinding(true);
        const executeCommand = (event: Event) => { const command = (event as CustomEvent).detail; if (command.documentId === id) tools.run(command.id); };
        window.addEventListener('editor-command', executeCommand);
        const search=(event:Event)=>{
            const {text,backward}=(event as CustomEvent).detail;
            if(!editor)return;
            editor.action(ctx=>{
                const view=ctx.get(editorViewCtx), matches:number[]=[];
                if(text)view.state.doc.descendants((node,pos)=>{
                    if(!node.isTextblock)return;
                    const content=node.textBetween(0,node.content.size,'\n','\n').toLowerCase();
                    let start=content.indexOf(text.toLowerCase());
                    while(start>=0){matches.push(pos+1+start);start=content.indexOf(text.toLowerCase(),start+Math.max(text.length,1));}
                    return false;
                });
                if(lastQuery!==text)findIndex=-1;
                lastQuery=text;
                findIndex=matches.length?(findIndex+(backward?-1:1)+matches.length)%matches.length:-1;
                setFindCount(matches.length?(findIndex+1)+' / '+matches.length:'无匹配');
                if(findIndex>=0)view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc,matches[findIndex],matches[findIndex]+text.length)).scrollIntoView());
            });
        };
        window.addEventListener('document-find',openFind);window.addEventListener('document-find-query',search);
        const unregister = registerBuffer('document:' + id,{
            dirty:()=>blocked || !!recoveryRef.current || sending || !!editor?.action(ctx=>sendableSteps(ctx.get(editorViewCtx).state)),
            flush:async()=>{
                if (editor?.action(ctx => !!sendableSteps(ctx.get(editorViewCtx).state))) keep();
                if (blocked) throw Error(t('正文同步暂停，请重试同步或下载正文后再离开'));
                if(recoveryRef.current) throw Error(t("正文有待恢复内容，请先处理恢复副本"));
                const deadline=Date.now()+10000;
                while(sending || editor?.action(ctx=>!!sendableSteps(ctx.get(editorViewCtx).state))) {
                    if(Date.now()>deadline || blocked) throw Error(t("正文尚未保存，请等待连接恢复"));
                    await pump(); await new Promise(resolve=>setTimeout(resolve,30));
                }
                splitGroup=true;
            }
        });
        const compositionEnd = () => { setTimeout(() => { void pull(); void pump(); }, 0); };
        const element = host.current;
        element?.addEventListener('compositionend', compositionEnd);
        const beforeUnload = (event: BeforeUnloadEvent) => { if (blocked || editor?.action(ctx => !!sendableSteps(ctx.get(editorViewCtx).state))) {
            keep();
            event.preventDefault();
        } };
        window.addEventListener('beforeunload', beforeUnload);
        const preserve = () => { if (editor?.action(ctx => !!sendableSteps(ctx.get(editorViewCtx).state))) keep(); };
        const visibility = () => { if (document.visibilityState === 'hidden') preserve(); };
        window.addEventListener('pagehide', preserve); document.addEventListener('visibilitychange', visibility);
        return () => { disposed = true; unregister(); window.removeEventListener('editor-command', executeCommand); window.removeEventListener('document-find',openFind); window.removeEventListener('document-find-query',search); element?.removeEventListener('compositionend', compositionEnd); unsubscribe(); clearTimeout(retry); window.removeEventListener('beforeunload', beforeUnload); if (editor) {
            if (editor.action(ctx => !!sendableSteps(ctx.get(editorViewCtx).state)))
                keep();
            void editor.destroy();
        } backup.cancel(); window.removeEventListener('pagehide', preserve); document.removeEventListener('visibilitychange', visibility); };
    }, [id]);
    return <div className="document-surface"><EditorTools controller={tools}/>{finding&&<div className="document-find"><input autoFocus aria-label={t("查找正文")} value={findText} onChange={event=>{setFindText(event.target.value);window.dispatchEvent(new CustomEvent('document-find-query',{detail:{text:event.target.value}}));}} onKeyDown={event=>{if(event.key==='Enter')window.dispatchEvent(new CustomEvent('document-find-query',{detail:{text:findText,backward:event.shiftKey}}));if(event.key==='Escape')setFinding(false);}}/><span>{findCount}</span><button onClick={()=>window.dispatchEvent(new CustomEvent('document-find-query',{detail:{text:findText}}))}>{t("下一处")}</button><button aria-label={t("关闭正文查找")} onClick={()=>setFinding(false)}>{t("关闭")}</button></div>}<div className="document-scroll">{heading}{syncNotice && <aside className="document-sync-notice" role="status"><p>{syncNotice}</p><button onClick={() => retrySync.current()}>{t("重试同步")}</button><button onClick={() => downloadCurrent.current()}>{t("下载当前正文")}</button></aside>}{recovery && <details className="recovery" open><summary>{t("本机保留了一份未确认输入，请对照后复制所需内容。")}</summary><textarea value={recovery} readOnly/><button onClick={() => { localStorage.removeItem('draft:' + getSnapshot()?.actor.userId + ':' + id); setRecovery(''); }}>{t("已检查，关闭副本")}</button></details>}<div className="document-editor" ref={host}/></div></div>;
}
