import { t } from './i18n';
import { useEffect, useId, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { editingChanged, flushEditing, locked, registerBuffer } from './editing';
import type { ChangeView } from './ViewControls';
export function ViewSearch({ value, save }: { value: string; save: ChangeView }) {
    const [text, setText] = useState(value), [error, setError] = useState('');
    const state = useRef({ text: value, dirty: false });
    const pending = useRef<Promise<void>|null>(null);
    const buffer = useId();
    const commit = async () => { if (pending.current) return pending.current; if (!state.current.dirty) return; const next = state.current.text; pending.current = save({ search: next }).then(() => { if (state.current.text === next) state.current.dirty = false; setError(''); }).catch(error => { setError(error.message); throw error; }).finally(() => { pending.current = null; editingChanged(); }); return pending.current; };
    const commitRef = useRef(commit); commitRef.current = commit;
    useEffect(() => { if (!state.current.dirty) { state.current.text = value; setText(value); } }, [value]);
    useEffect(() => registerBuffer('view-search:' + buffer, { dirty: () => state.current.dirty || !!pending.current, flush: () => commitRef.current() }), [buffer]);
    return <form className="view-search" onSubmit={event => { event.preventDefault(); void commit().catch(() => {}); }}><Search size={14}/><input aria-label={t("快速搜索视图")} placeholder={t("搜索可见字段，Enter 应用")} readOnly={locked()} value={text} onFocus={() => { if (!state.current.dirty) void flushEditing().catch(error => setError(error.message)); }} onChange={event => { state.current = { text: event.target.value, dirty: true }; setText(event.target.value); editingChanged(); }} onBlur={() => void commit().catch(() => {})}/><button disabled={locked()} type="submit">{t("搜索")}</button>{error && <span className="error">{t(error)}</span>}</form>;
}
