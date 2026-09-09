import { t } from './i18n';
import { Boxes, Plus } from 'lucide-react';
import type { Collection, CollectionView as View } from '../shared/model';
import { CollectionGrid } from './CollectionView';
import { EntityMenuButton } from './CommandSurface';
import { locked } from './editing';
import { createCollectionView } from './commands';
import { navigate, notify } from './state';

export function CollectionPanel({ collection, views, viewId, editSchema }: {
    collection?: Collection; views: View[]; viewId?: string; editSchema: (collection: Collection) => void;
}) {
    if (!collection) return <div className="empty spacious"><Boxes size={32}/><h2>{t("集合已删除或不存在")}</h2><p>{t("可以从左侧打开其他集合，或在操作历史中撤销删除。")}</p></div>;
    return <div className="page-panel collection-panel" data-history-scope={collection.id}>
        <section className="collection-section" data-entity-id={collection.id} tabIndex={0}>
            <div className="section-heading"><div><span className="eyebrow">{t("我的草稿 / 结构化集合")}</span><h1>{collection.title}</h1><p>{t("所有视图与文档嵌入共享同一份记录。")}</p></div><div className="actions"><button disabled={locked()} onClick={() => editSchema(collection)}>{t("编辑字段结构")}</button><button disabled={locked()} onClick={() => void createCollectionView(collection.id).catch(error => notify(error.message, true))}><Plus size={15}/>{t("新增视图")}</button><EntityMenuButton id={collection.id} title={collection.title}/></div></div>
            {views.length > 0 && <nav className="collection-view-tabs" aria-label={t("集合视图")}>{views.map(view => <button key={view.id} className={view.id === viewId ? 'current' : ''} aria-current={view.id === viewId ? 'page' : undefined} onClick={() => navigate(view.id)}>{view.title}</button>)}</nav>}
            {viewId ? <CollectionGrid key={viewId} viewId={viewId}/> : <div className="empty spacious"><Boxes size={30}/><h2>{t("为集合创建第一个视图")}</h2><p>{t("先创建视图，再添加记录；表格、列表和卡片可以随时切换。")}</p></div>}
        </section>
    </div>;
}
