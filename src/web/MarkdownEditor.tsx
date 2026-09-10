import { useEffect, useRef, useState } from 'react';
import { api, currentProject, getSnapshot, reload, useSnapshot } from './state';
import { editingChanged, locked, registerBuffer } from './editing';
import { randomUUID } from './uuid';
import { t } from './i18n';

export function MarkdownEditor({ id, reason, onClose }: { id: string; reason: string; onClose: () => void }) {
    useSnapshot();
    const key = 'markdown:' + currentProject() + ':' + getSnapshot()?.actor.userId + ':' + id;
    const [body, setBody] = useState(''), [base, setBase] = useState(''), [ready, setReady] = useState(false);
    const [error, setError] = useState(''), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false);
    const [remote, setRemote] = useState<string | null>(null);
    const [recovery, setRecovery] = useState(() => localStorage.getItem('draft:' + getSnapshot()?.actor.userId + ':' + id) || '');
    const pending = useRef<{ requestId: string; expected: string; body: string } | null>(null);
    const saving = useRef<Promise<void> | null>(null);
    const state = useRef({ body, base, ready, busy, uncertain });
    state.current = { body, base, ready, busy, uncertain };
    const persist = (text: string, expected: string) => {
        try { localStorage.setItem(key, JSON.stringify({ body: text, base: expected })); }
        catch { setError(t('无法保存本机副本，请下载源码备份')); }
    };
    const load = async () => {
        try {
            const result = await api('/documents/' + encodeURIComponent(id) + '/source');
            const saved = localStorage.getItem(key);
            let draft: { body: string; base: string } | null = null;
            try { draft = saved ? JSON.parse(saved) : null; } catch { setError(t('本机源码副本格式异常，请保留副本')); }
            if (draft && typeof draft.body === 'string' && typeof draft.base === 'string') {
                setBody(draft.body); setBase(draft.base);
                if (draft.base !== result.body) setRemote(result.body);
            } else { setBody(result.body); setBase(result.body); }
            setReady(true);
        } catch (failure: any) { setError(failure.message); }
    };
    useEffect(() => { void load(); }, [id]);
    const save = (): Promise<void> => {
        if (saving.current) return saving.current;
        if (!state.current.ready || locked()) return Promise.reject(Error(t('当前不能保存，请检查权限或等待 Agent 释放控制权')));
        saving.current = (async () => {
            const input = pending.current || { requestId: randomUUID(), expected: state.current.base, body: state.current.body };
            pending.current = input;
            persist(input.body, input.expected);
            setBusy(true); setError('');
            try {
                const result = await api('/documents/' + encodeURIComponent(id) + '/source', input);
                pending.current = null; setUncertain(false); setBase(result.body); setBody(result.body);
                state.current = { ...state.current, base: result.body, body: result.body, uncertain: false };
                localStorage.removeItem(key); setRemote(null);
                setError(result.warning ? t('源码已保存，富文本仍不可用：') + result.warning.reason : t('源码已保存'));
                try { await reload(); } catch { setError(t('源码已保存，但工作区刷新失败；请稍后刷新')); }
            } catch (failure: any) {
                const unknown = !failure.status || failure.status >= 500;
                setUncertain(unknown);
                if (!unknown) pending.current = null;
                setError(failure.message + (unknown ? t('；结果未确认，请重试同一保存请求') : ''));
                if (failure.status === 409) {
                    try { setRemote((await api('/documents/' + encodeURIComponent(id) + '/source')).body); } catch { }
                }
                throw failure;
            } finally { setBusy(false); saving.current = null; editingChanged(); }
        })();
        return saving.current;
    };
    const saveRef = useRef(save); saveRef.current = save;
    useEffect(() => {
        const dirty = () => state.current.body !== state.current.base || !!pending.current || !!saving.current;
        const unregister = registerBuffer('markdown:' + id, { dirty, flush: async () => { if (dirty()) await saveRef.current(); } });
        const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty()) event.preventDefault(); };
        window.addEventListener('beforeunload', beforeUnload);
        return () => { unregister(); window.removeEventListener('beforeunload', beforeUnload); };
    }, [id]);
    useEffect(() => { editingChanged(); }, [body, base, busy, uncertain]);
    return <section className="markdown-source">
        <p role="status">{reason || t('Markdown 源码模式：直接编辑原文，不依赖富文本渲染。')}</p>
        {error && <p role="alert">{error}</p>}
        {!ready && <button onClick={() => void load()}>{t('重新读取源码')}</button>}
        {recovery && <details open><summary>{t('富文本未确认输入副本（请对照后手动合并）')}</summary><textarea aria-label={t('富文本恢复副本')} value={recovery} readOnly/><button onClick={() => { localStorage.removeItem('draft:' + getSnapshot()?.actor.userId + ':' + id); setRecovery(''); }}>{t('已检查，关闭副本')}</button></details>}
        {remote !== null && <details open><summary>{t('服务端正文已变化：请对照合并，不会自动覆盖')}</summary><textarea aria-label={t('最新服务端源码')} value={remote} readOnly/><button disabled={busy || uncertain} onClick={() => { setBase(remote); persist(body, remote); setRemote(null); }}>{t('已对照，以此版本为保存基线')}</button></details>}
        <textarea aria-label={t('Markdown 源码')} spellCheck={false} value={body} disabled={!ready || busy || uncertain || locked()} onChange={event => { setBody(event.target.value); persist(event.target.value, base); }}/>
        <div><button disabled={!ready || busy || locked()} onClick={() => void save().catch(() => {})}>{t(uncertain ? '重试确认保存' : '保存源码')}</button><button disabled={!ready || busy || uncertain || body !== base} onClick={onClose}>{t('尝试富文本编辑')}</button><button onClick={() => { const url = URL.createObjectURL(new Blob([body], { type: 'text/markdown;charset=utf-8' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = id + '.md'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>{t('下载源码副本')}</button></div>
    </section>;
}
