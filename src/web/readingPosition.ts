export type ReadingPosition = Record<string, { top: number; left: number; anchor?: { text: string; index: number; offset: number } }>;

function containers() {
    const elements = new Map<string, HTMLElement>();
    const content = document.querySelector<HTMLElement>('.content');
    if (content) elements.set('content', content);
    const documentScroll = document.querySelector<HTMLElement>('.document-scroll');
    if (documentScroll) elements.set('document', documentScroll);
    document.querySelectorAll<HTMLElement>('.content .table-scroll').forEach((element, index) => {
        elements.set('table:' + (element.closest<HTMLElement>('[data-view]')?.dataset.view || '') + ':' + index, element);
    });
    return elements;
}

export function captureReadingPosition(): ReadingPosition {
    const position: ReadingPosition = {};
    for (const [key, element] of containers()) {
        const saved: ReadingPosition[string] = { top: element.scrollTop, left: element.scrollLeft };
        if (key === 'document') {
            const blocks = [...element.querySelectorAll<HTMLElement>('.milkdown .editor > *')];
            const edge = element.getBoundingClientRect().top;
            const index = blocks.findIndex(block => block.getBoundingClientRect().bottom > edge);
            const block = blocks[index];
            if (block) saved.anchor = { text: block.textContent?.slice(0, 160) || '', index, offset: block.getBoundingClientRect().top - edge };
        }
        position[key] = saved;
    }
    return position;
}

export function restoreReadingPosition(position: ReadingPosition, onChange: () => void) {
    const content = document.querySelector<HTMLElement>('.content');
    if (!content) return () => {};
    let restoring = true;
    let frame = 0;
    let saveFrame = 0;
    const expected = new WeakMap<HTMLElement, { top: number; left: number }>();
    const apply = () => {
        if (!restoring) return;
        for (const [key, element] of containers()) {
            const saved = position[key];
            let top = saved?.top || 0;
            if (saved?.anchor) {
                const blocks = [...element.querySelectorAll<HTMLElement>('.milkdown .editor > *')];
                const anchor = saved.anchor;
                const matches = blocks.filter(block => block.textContent?.slice(0, 160) === anchor.text);
                const block = matches.sort((first, second) => Math.abs(blocks.indexOf(first) - anchor.index) - Math.abs(blocks.indexOf(second) - anchor.index))[0];
                if (block) top = element.scrollTop + block.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.offset;
            }
            element.scrollTop = top;
            element.scrollLeft = saved?.left || 0;
            expected.set(element, { top: element.scrollTop, left: element.scrollLeft });
        }
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(apply); };
    const mutation = new MutationObserver(schedule);
    const resize = new ResizeObserver(schedule);
    mutation.observe(content, { childList: true, subtree: true });
    resize.observe(content);
    const stop = () => { restoring = false; mutation.disconnect(); resize.disconnect(); cancelAnimationFrame(frame); };
    const interact = (event: Event) => {
        if (event instanceof MouseEvent && event.button !== 0) return;
        stop();
    };
    const scroll = (event: Event) => {
        const element = event.target as HTMLElement;
        const target = expected.get(element);
        if (restoring && target && (Math.abs(element.scrollTop - target.top) > 1 || Math.abs(element.scrollLeft - target.left) > 1)) stop();
        if (!restoring) { cancelAnimationFrame(saveFrame); saveFrame = requestAnimationFrame(onChange); }
    };
    content.addEventListener('wheel', interact, { passive: true });
    content.addEventListener('touchstart', interact, { passive: true });
    content.addEventListener('pointerdown', interact);
    content.addEventListener('keydown', interact);
    content.addEventListener('scroll', scroll, true);
    const find = () => stop();
    window.addEventListener('document-find-query', find);
    void document.fonts.ready.then(schedule);
    apply();
    return () => {
        stop();
        cancelAnimationFrame(saveFrame);
        content.removeEventListener('wheel', interact);
        content.removeEventListener('touchstart', interact);
        content.removeEventListener('pointerdown', interact);
        content.removeEventListener('keydown', interact);
        content.removeEventListener('scroll', scroll, true);
        window.removeEventListener('document-find-query', find);
    };
}
