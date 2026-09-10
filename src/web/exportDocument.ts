import { getSnapshot } from './state';
import { flushEditing } from './editing';
import { serialize } from '../shared/model';
import { t } from './i18n';

export async function exportDocument(id: string) {
    const projectId = getSnapshot()!.project.id;
    await flushEditing();
    const snapshot = getSnapshot();
    if (!snapshot || snapshot.project.id !== projectId) throw Error(t('项目已切换，请重新导出'));
    const entity = snapshot.tree[id];
    if (entity?.kind !== 'object') throw Error(t('文档不存在'));
    let blob: Blob;
    const withImages = entity.body.includes('/assets/');
    if (withImages) {
        const response = await fetch('/api/projects/' + encodeURIComponent(projectId) + '/documents/' + encodeURIComponent(id) + '/export-images');
        if (!response.ok) throw Error((await response.json()).error);
        blob = await response.blob();
    } else blob = new Blob([serialize(entity)], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const name = entity.path.split('/').at(-1)!;
    link.href = url; link.download = withImages ? name + '.zip' : name;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
