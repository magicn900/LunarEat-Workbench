import { t } from './i18n';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
export function Modal({ title, children, onClose, className = '', busy = false }: { title: string; children: ReactNode; onClose: () => void; className?: string; busy?: boolean }) {
    const panel = useRef<HTMLElement>(null);
    const [layer] = useState(() => document.querySelectorAll('[data-modal-layer]').length);
    useEffect(() => { const previous = document.activeElement as HTMLElement | null; panel.current?.focus(); return () => { if (previous?.isConnected) previous.focus(); }; }, []);
    return createPortal(<div className="modal-backdrop" data-modal-layer={layer} style={{ zIndex: `calc(var(--layer-dialog) + ${layer})` }} onMouseDown={event => { if (!busy && event.target === event.currentTarget) onClose(); }}><section ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={'modal ' + className} onKeyDown={event => {
        if ((event.target as HTMLElement).closest('[role=dialog]') !== event.currentTarget) return;
        if (event.key === 'Escape') { event.stopPropagation(); if (!busy) onClose(); }
        if (event.key === 'Tab') { event.stopPropagation(); const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')].filter(control => control.getClientRects().length > 0); if (!controls.length) { event.preventDefault(); return; } if (event.shiftKey && (document.activeElement === controls[0] || document.activeElement === panel.current)) { event.preventDefault(); controls.at(-1)?.focus(); } else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); } }
    }}><header><h2>{title}</h2><button className="icon" onClick={onClose} disabled={busy} aria-label={t("关闭")}><X size={18}/></button></header>{children}</section></div>, document.body);
}
