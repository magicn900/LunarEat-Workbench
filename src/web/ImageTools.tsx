import { useState, useSyncExternalStore } from 'react';
import { ImagePlus, Maximize2, Pencil, Trash2 } from 'lucide-react';
import { ImageController } from './ImageController';
import { Modal } from './Modal';
import { locked } from './editing';
import { t } from './i18n';

export function ImageTools({ controller }: { controller: ImageController }) {
    const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
    const [naturalSize, setNaturalSize] = useState(false);
    return <>
        {state.selected && <div className="image-toolbar" role="toolbar" aria-label={t('图片编辑')}>
            <span>{t('图片')}</span>
            <button onMouseDown={event => event.preventDefault()} onClick={() => { setNaturalSize(false); controller.openPreview(state.selected!.src, state.selected!.alt); }}><Maximize2 size={15}/>{t('查看原图')}</button>
            <button disabled={locked()} onMouseDown={event => event.preventDefault()} onClick={() => controller.choose(true)}><ImagePlus size={15}/>{t('替换图片')}</button>
            <button disabled={locked()} onMouseDown={event => event.preventDefault()} onClick={() => { const alt = prompt(t('图片替代文字'), state.selected!.alt); if (alt !== null) controller.editAlt(alt.slice(0, 2000)); }}><Pencil size={15}/>{t('编辑说明')}</button>
            <button disabled={locked()} onMouseDown={event => event.preventDefault()} onClick={controller.remove}><Trash2 size={15}/>{t('移除图片')}</button>
        </div>}
        {state.preview && <Modal title={t('查看原图')} onClose={controller.closePreview} className="image-preview-dialog">
            <div className="image-preview-actions"><button aria-pressed={naturalSize} onClick={() => setNaturalSize(!naturalSize)}>{naturalSize ? t('适应窗口') : t('原始尺寸')}</button><span>{state.preview.alt}</span></div>
            <div className={'image-preview-scroll' + (naturalSize ? ' natural-size' : '')}><img src={state.preview.src} alt={state.preview.alt}/></div>
        </Modal>}
    </>;
}
