import { t } from './i18n';
import { useEffect, useRef } from 'react';
import { DOMSerializer } from '@milkdown/prose/model';
import type { Schema, Node } from '@milkdown/prose/model';
import { useSnapshot, navigate } from './state';
export function DocumentEmbed({ id, parse, schema }: {
    id: string;
    parse: (text: string) => Node;
    schema: Schema;
}) {
    const snapshot = useSnapshot(), host = useRef<HTMLDivElement>(null);
    const entity = snapshot?.tree[id];
    useEffect(() => { if (!host.current || entity?.kind !== 'object')
        return; const fragment = DOMSerializer.fromSchema(schema).serializeFragment(parse(entity.body).content); host.current.replaceChildren(fragment); }, [entity, parse, schema]);
    return <section className="document-embed" contentEditable={false}><header><span className="eyebrow">{t("文档引用 · 只读嵌入")}</span><button onClick={() => navigate(id)}>{entity?.title || t("目标不存在")} ↗</button></header><div ref={host}/><small>{t("编辑请打开原页面；不递归展开嵌入，避免循环引用。")}</small></section>;
}
