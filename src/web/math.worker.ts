import { previewFormula } from './mathPreview';
self.onmessage = (event: MessageEvent<{ id: number; source: string; display: boolean }>) => {
    const { id, source, display } = event.data;
    self.postMessage({ id, ...previewFormula(source, display) });
};
