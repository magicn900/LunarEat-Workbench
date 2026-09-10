import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';

export function TextCell(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
    const ref = useRef<HTMLTextAreaElement>(null);
    const resize = () => {
        const element = ref.current;
        if (!element) return;
        element.style.height = '0px';
        element.style.height = element.scrollHeight + 2 + 'px';
    };
    useLayoutEffect(resize, [props.value]);
    useLayoutEffect(() => {
        const element = ref.current;
        if (!element) return;
        let width = -1;
        const observer = new ResizeObserver(entries => {
            const next = entries[0].contentRect.width;
            if (next !== width) { width = next; resize(); }
        });
        observer.observe(element);
        void document.fonts.ready.then(resize);
        return () => observer.disconnect();
    }, []);
    return <textarea {...props} ref={ref} rows={1} className="text-cell"/>;
}
