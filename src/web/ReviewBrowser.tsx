import { t } from './i18n';
import { useState } from 'react';
import { FileText, RotateCcw } from 'lucide-react';
import { reviewText } from './reviewText';
import type { DiscardTarget, ReviewItem } from '../shared/review';
function printable(value: unknown, whitespace: boolean): string {
    const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value, null, 2);
    return text === '' ? t('（空）') : whitespace ? text.replace(/ /g, '·').replace(/\t/g, '⇥').replace(/\n/g, '↵\n') : text;
}
export function DifferenceText({ before, after, whitespace = false, property }: { before: unknown; after: unknown; whitespace?: boolean; property?: string }) {
    return <div className="review-comparison"><section><span>{t("修改前")}</span><pre className="removed">{printable(property ? reviewText(before, property) : before, whitespace)}</pre></section><section><span>{t("修改后")}</span><pre className="added">{printable(property ? reviewText(after, property) : after, whitespace)}</pre></section></div>;
}
export function ReviewBrowser({ items, discard, disabled = false }: { items: ReviewItem[]; discard?: (targets: DiscardTarget[]) => void; disabled?: boolean }) {
    const [selected, setSelected] = useState(''), [whitespace, setWhitespace] = useState(false);
    const files = [...new Map(items.map(item => [item.id, { id: item.id, title: item.title, path: item.path }])).values()];
    const active = files.find(file => file.id === selected) || files[0];
    const changes = items.filter(item => item.id === active?.id);
    if (!items.length) return <div className="release-empty"><FileText size={28}/><h3>{t("草稿已与起点一致")}</h3><p>{t("没有需要发布的修改，可以继续编辑。")}</p></div>;
    return <div className="review-browser"><nav aria-label={t("修改的文件")} className="review-files">{files.map(file => <button key={file.id} aria-current={file.id === active?.id ? 'true' : undefined} onClick={() => setSelected(file.id)}><FileText size={16}/><span><strong>{file.title}</strong><small>{file.path}</small></span><small>{items.filter(item => item.id === file.id).length}</small></button>)}</nav><section className="review-detail" aria-label={t("修改详情")}><header><div><strong>{active.title}</strong><small>{active.path}</small></div>{discard && <details className="review-more"><summary aria-label={t("文件操作 ") + active.title}>⋯</summary><button disabled={disabled} onClick={() => discard([{ id: active.id }])}>{t("丢弃此文件的全部修改")}</button></details>}</header><label className="check-row"><input type="checkbox" checked={whitespace} onChange={event => setWhitespace(event.target.checked)}/>{t("显示空白符")}</label>{changes.map(item => <article className="review-change" key={item.key}><header><span className="badge">{t(item.kind)}</span><strong>{item.kind === '字段' ? item.label : item.range ? t('正文 · 第 ') + item.range.line + t(' 行附近') : t(item.label)}</strong>{discard && <button className="discard-action" disabled={disabled} onClick={() => discard([{ id: item.id, key: item.key }])}><RotateCcw size={13}/>{t("丢弃此项修改")}</button>}</header><DifferenceText before={item.before} after={item.after} whitespace={whitespace} property={item.kind === '字段' ? 'value' : item.property}/></article>)}</section></div>;
}
