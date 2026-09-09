import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { registerManualCopy } from './clipboard';
import { t } from './i18n';
import './clipboard.css';
type Request = { text: string; resolve: (copied: boolean) => void };
export function ClipboardDialog() {
    const [request, setRequest] = useState<Request | null>(null);
    const pending = useRef<Request | null>(null);
    const finish = (copied: boolean) => {
        const current = pending.current;
        pending.current = null;
        setRequest(null);
        current?.resolve(copied);
    };
    useEffect(() => {
        let active = true;
        const unregister = registerManualCopy(text => {
            if (!active) return Promise.resolve(false);
            finish(false);
            return new Promise(resolve => { const next = { text, resolve }; pending.current = next; setRequest(next); });
        });
        const cancel = () => { active = false; unregister(); finish(false); };
        window.addEventListener('identity-changed', cancel);
        window.addEventListener('pagehide', cancel);
        return () => { cancel(); window.removeEventListener('identity-changed', cancel); window.removeEventListener('pagehide', cancel); };
    }, []);
    return request && <ManualCopy text={request.text} finish={finish}/>;
}
function ManualCopy({ text, finish }: { text: string; finish: (copied: boolean) => void }) {
    const textarea = useRef<HTMLTextAreaElement>(null);
    const select = () => { textarea.current?.focus({ preventScroll: true }); textarea.current?.select(); };
    useEffect(() => { const frame = requestAnimationFrame(select); return () => cancelAnimationFrame(frame); }, [text]);
    return <Modal title={t('手动复制')} className="clipboard-dialog" onClose={() => finish(false)}>
        <p>{t('浏览器未允许自动复制。下方是完整内容，请按 Ctrl+C（Mac 使用 Cmd+C），或使用系统的复制菜单。')}</p>
        <textarea ref={textarea} aria-label={t('待复制内容')} value={text} readOnly spellCheck={false}/>
        <p className="clipboard-hint">{t('如果包含密钥，请仅粘贴到可信位置。关闭此窗口不会自动标记为已复制。')}</p>
        <footer><button onClick={select}>{t('重新全选')}</button><div className="spacer"/><button onClick={() => finish(false)}>{t('取消')}</button><button className="primary" onClick={() => finish(true)}>{t('我已复制')}</button></footer>
    </Modal>;
}
