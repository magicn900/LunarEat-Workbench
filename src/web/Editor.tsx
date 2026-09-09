import { randomUUID } from './uuid';
import { t } from './i18n';
import { useEffect, useRef, useState, useMemo, type ReactNode } from 'react';
import { EditorTools } from './EditorTools';
import { EditorToolsController } from './editorCommands';
import { createEmbedNodeView } from './EmbeddedBlock';
import { embedSchema, embedRemark, documentSchemaVersion } from '../shared/embeds';
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, serializerCtx, parserCtx, schemaCtx } from '@milkdown/core';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { locked, registerBuffer, editingChanged } from './editing';
import { $prose } from '@milkdown/utils';
import { Plugin, TextSelection } from '@milkdown/prose/state';

import { Step } from '@milkdown/prose/transform';
import { collab, sendableSteps, getVersion, receiveTransaction } from 'prosemirror-collab';
import { api, getSnapshot, subscribe, notify, navigate } from './state';


export function DocumentEditor({ id, onStatus, heading }: {
    id: string;
    onStatus: (status: string) => void;
    heading: ReactNode;
}) {
    const host = useRef<HTMLDivElement>(null);
    const tools = useMemo(() => new EditorToolsController(id), [id]);
    const [recovery, setRecovery] = useState('');
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
        const keep = () => { if (editor)
            editor.action(ctx => { const text = ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc); localStorage.setItem(recoveryKey, text); }); };
        const consume = (remote: any) => {
            if (remote.schemaVersion !== documentSchemaVersion) { blocked = true; keep(); notify(t("编辑器协议已更新，请保存恢复副本并刷新页面"), true); return; }
            if (!editor || disposed || editor.action(ctx => ctx.get(editorViewCtx).composing))
                return;
            editor.action(ctx => {
                const view = ctx.get(editorViewCtx);
                const version = getVersion(view.state);
                if (remote.version === version)
                    return;
                if (remote.steps.length !== remote.version - version) {
                    keep();
                    setRecovery(localStorage.getItem(recoveryKey) || '');
                    onStatusRef.current('需要恢复');
                    return;
                }
                if (remote.clientIds.some((remoteId: string) => remoteId !== clientId)) splitGroup = true;
                const before = sendableSteps(view.state)?.steps.length || 0;
                view.dispatch(receiveTransaction(view.state, remote.steps.map((step: any) => Step.fromJSON(view.state.schema, step)), remote.clientIds));
                const after = sendableSteps(view.state)?.steps.length || 0;
                if (before > 0 && after < before && !remote.clientIds.includes(clientId)) {
                    setRecovery(localStorage.getItem(recoveryKey) || '');
                    notify(t("远端修改与未保存输入重叠，请检查恢复副本"), true);
                }
            });
        };
        const pull = async () => { if (pulling || !editor || disposed || editor.action(ctx => ctx.get(editorViewCtx).composing))
            return; pulling = true; try {
            const version = editor.action(ctx => getVersion(ctx.get(editorViewCtx).state));
            consume(await api('/documents/' + id + '?since=' + version));
        }
        catch (error: any) {
            onStatusRef.current(error.status === 404 ? '页面已删除' : '连接中断');
        }
        finally {
            pulling = false;
        } };
        const pump = async () => {
            if (!editor || disposed || sending || blocked || editor.action(ctx => ctx.get(editorViewCtx).composing))
                return;
            const pending = editor.action(ctx => sendableSteps(ctx.get(editorViewCtx).state));
            if (!pending) {
                if(!recoveryRef.current) localStorage.removeItem(recoveryKey);
                onStatusRef.current('已保存');
                return;
            }
            sending = true;
            onStatusRef.current('保存中');
            keep();
            const signature = JSON.stringify({ version: pending.version, steps: pending.steps.map(step => step.toJSON()) });
            if (signature !== batchSignature) {
                batchSignature = signature;
                batchRequestId = randomUUID();
                if (splitGroup || Date.now()-lastBatch > 750) groupId = 'human:' + randomUUID();
                lastBatch=Date.now(); splitGroup=false;
            }
            try {
                const result = await api('/documents/' + id + '/steps', { requestId: batchRequestId, version: pending.version, steps: pending.steps.map(step => step.toJSON()), clientId, groupId });
                consume(result.document);
                if (!editor.action(ctx => sendableSteps(ctx.get(editorViewCtx).state)))
                    localStorage.removeItem(recoveryKey);
            }
            catch (error: any) {
                if (error.status === 409) {
                    const current = await api('/documents/' + id + '?since=' + pending.version);
                    if (current.version === pending.version) {
                        blocked = true;
                        setRecovery(localStorage.getItem(recoveryKey) || '');
                        onStatusRef.current('冲突 · 请保留输入后重新打开页面');
                        return;
                    }
                    consume(current);
                }
                else if (error.status >= 400 && error.status < 500) {
                    blocked = true;
                    setRecovery(localStorage.getItem(recoveryKey) || '');
                    onStatusRef.current(error.message);
                    return;
                }
                else {
                    onStatusRef.current('连接中断 · 输入已保留');
                    retry = setTimeout(() => void pump(), 1500);
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
                editor = await Editor.make().config(ctx => { ctx.set(rootCtx, host.current); ctx.set(defaultValueCtx, { type: 'json', value: initial.doc }); }).use(commonmark).use(gfm).use(embedRemark).use(embedSchema).use($prose(() => tools.plugin)).use($prose(() => collab({ version: initial.version, clientID: clientId }))).use(widgets).use($prose(() => new Plugin({ props: { editable: () => !locked() }, view: () => ({ update() { if (editor) {
                            keep();
                            queueMicrotask(() => void pump());
                        } } }) }))).create();
                if (disposed) {
                    await editor.destroy();
                    return;
                }
                unsubscribe = subscribe(() => { editor?.action(ctx=>ctx.get(editorViewCtx).setProps({editable:()=>!locked()})); void pull(); });
                onStatusRef.current('已保存');
                await pull();
            }
            catch (error: any) {
                notify(error.message, true);
                onStatusRef.current('编辑器加载失败');
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
            dirty:()=>!!recoveryRef.current || sending || !!editor?.action(ctx=>sendableSteps(ctx.get(editorViewCtx).state)),
            flush:async()=>{
                if(recoveryRef.current || blocked) throw Error(t("正文有待恢复内容，请先处理恢复副本"));
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
        const beforeUnload = (event: BeforeUnloadEvent) => { if (editor?.action(ctx => !!sendableSteps(ctx.get(editorViewCtx).state))) {
            keep();
            event.preventDefault();
        } };
        window.addEventListener('beforeunload', beforeUnload);
        return () => { disposed = true; unregister(); window.removeEventListener('editor-command', executeCommand); window.removeEventListener('document-find',openFind); window.removeEventListener('document-find-query',search); element?.removeEventListener('compositionend', compositionEnd); unsubscribe(); clearTimeout(retry); window.removeEventListener('beforeunload', beforeUnload); if (editor) {
            if (editor.action(ctx => !!sendableSteps(ctx.get(editorViewCtx).state)))
                keep();
            void editor.destroy();
        } };
    }, [id]);
    return <div className="document-surface"><EditorTools controller={tools}/>{finding&&<div className="document-find"><input autoFocus aria-label={t("查找正文")} value={findText} onChange={event=>{setFindText(event.target.value);window.dispatchEvent(new CustomEvent('document-find-query',{detail:{text:event.target.value}}));}} onKeyDown={event=>{if(event.key==='Enter')window.dispatchEvent(new CustomEvent('document-find-query',{detail:{text:findText,backward:event.shiftKey}}));if(event.key==='Escape')setFinding(false);}}/><span>{findCount}</span><button onClick={()=>window.dispatchEvent(new CustomEvent('document-find-query',{detail:{text:findText}}))}>{t("下一处")}</button><button aria-label={t("关闭正文查找")} onClick={()=>setFinding(false)}>{t("关闭")}</button></div>}<div className="document-scroll">{heading}{recovery && <details className="recovery" open><summary>{t("本机保留了一份未确认输入，请对照后复制所需内容。")}</summary><textarea value={recovery} readOnly/><button onClick={() => { localStorage.removeItem('draft:' + getSnapshot()?.actor.userId + ':' + id); setRecovery(''); }}>{t("已检查，关闭副本")}</button></details>}<div className="document-editor" ref={host}/></div></div>;
}
