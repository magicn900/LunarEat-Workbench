type ManualCopy = (text: string) => Promise<boolean>;
let manualCopy: ManualCopy | null = null;
let generation = 0;
export function registerManualCopy(handler: ManualCopy) {
    manualCopy = handler;
    return () => { if (manualCopy === handler) { manualCopy = null; generation++; } };
}
function legacyCopy(text: string): boolean {
    if (typeof document.execCommand !== 'function') return false;
    const previous = document.activeElement as HTMLElement | null;
    const selection = document.getSelection();
    const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
    const input = previous instanceof HTMLInputElement || previous instanceof HTMLTextAreaElement ? previous : null;
    const start = input?.selectionStart, end = input?.selectionEnd;
    const buffer = document.createElement('textarea');
    buffer.value = text;
    buffer.readOnly = true;
    buffer.tabIndex = -1;
    buffer.setAttribute('aria-hidden', 'true');
    Object.assign(buffer.style, { position: 'fixed', top: '0', left: '0', width: '1px', height: '1px', opacity: '0' });
    try {
        document.body.append(buffer);
        buffer.focus({ preventScroll: true });
        buffer.select();
        return document.execCommand('copy');
    } catch { return false; }
    finally {
        buffer.remove();
        try {
            if (previous?.isConnected) previous.focus({ preventScroll: true });
            if (input?.isConnected && start != null && end != null) input.setSelectionRange(start, end);
            else if (selection) { selection.removeAllRanges(); for (const range of ranges) if (range.commonAncestorContainer.isConnected) selection.addRange(range); }
        } catch { }
    }
}
export async function copyText(text: string): Promise<boolean> {
    const owner = manualCopy, request = ++generation;
    try {
        if (typeof navigator.clipboard?.writeText === 'function') {
            await navigator.clipboard.writeText(text);
            return request === generation;
        }
    } catch { }
    if (request !== generation || owner !== manualCopy) return false;
    if (legacyCopy(text)) return true;
    return owner ? owner(text) : false;
}
