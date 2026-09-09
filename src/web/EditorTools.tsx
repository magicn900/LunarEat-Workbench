import { t } from './i18n';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Bold, Italic, Link2, Boxes, FileText, Undo2, Redo2, X, Search } from 'lucide-react';
import { EditorToolsController, type Picker } from './editorCommands';
import { locked } from './editing';
import { useSnapshot } from './state';

function InsertPicker({ controller, picker }: { controller: EditorToolsController; picker: Picker }) {
    const snapshot = useSnapshot();
    const initialTarget = picker.initial.startsWith('doc:') ? snapshot?.tree[picker.initial.slice(4)]?.title || '' : picker.initial;
    const [query, setQuery] = useState(initialTarget), [label, setLabel] = useState(picker.label);
    const entities = Object.values(snapshot?.tree || {}).filter(entity => picker.kind === 'view' ? entity.kind === 'view' : picker.kind === 'doc' ? entity.kind === 'object' : entity.kind !== 'folder');
    const matches = entities.filter(entity => (entity.title + ' ' + entity.path + ' ' + (entity.kind === 'view' || entity.kind === 'object' && entity.collection ? snapshot?.tree[entity.collection!]?.title || '' : '')).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    const [index, setIndex] = useState(0);
    const source = picker.kind === 'source';
    useEffect(() => { document.getElementById('insert-target-' + matches[index]?.id)?.scrollIntoView({ block: 'nearest' }); }, [index, query]);
    return createPortal(<div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) controller.close(); }}><section className="modal insert-picker" role="dialog" aria-modal="true" aria-label={source ? t("编辑嵌入语法") : picker.kind === 'link' ? t("插入链接") : picker.kind === 'view' ? t("嵌入集合视图") : t("嵌入文档")} onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); controller.close(); }
        if (event.key === 'Tab') { const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input,textarea')]; if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); } else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); } }
    }}><header><h2>{source ? t("编辑嵌入语法") : picker.kind === 'link' ? t("插入链接") : picker.kind === 'view' ? t("嵌入集合视图") : t("嵌入文档")}</h2><button aria-label={t("关闭插入窗口")} onClick={controller.close}><X size={16}/></button></header>
        {picker.invalid && <p className="error">{t("原位置已改变，请关闭后重新选择插入位置。")}</p>}
        {source ? <><textarea autoFocus aria-label={t("嵌入语法")} value={query} onChange={event => setQuery(event.target.value)}/><button className="primary" disabled={locked() || picker.invalid} onClick={() => controller.insert(query)}>{t("保存嵌入")}</button></> : <>
            <label className="insert-search"><Search size={16}/><input autoFocus role="combobox" aria-label={t("搜索插入目标")} aria-expanded="true" aria-controls="insert-targets" aria-activedescendant={matches[index] ? 'insert-target-' + matches[index].id : undefined} placeholder={picker.kind === 'link' ? t("搜索页面、记录、集合，或输入网址…") : t("输入名称搜索，不需要记住 ID…")} value={query} onChange={event => { setQuery(event.target.value); setIndex(0); }} onKeyDown={event => { if (event.nativeEvent.isComposing) return; if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setIndex(current => Math.max(0, Math.min(matches.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))); } if (event.key === 'Enter' && matches[index]) { event.preventDefault(); controller.insert(matches[index].id, label); } }}/></label>
            {picker.kind === 'link' && <label>{t("显示文字（可选）")}<input aria-label={t("链接显示文字")} placeholder={t("默认使用目标名称")} value={label} onChange={event => setLabel(event.target.value)}/></label>}
            <div id="insert-targets" role="listbox" aria-label={t("插入目标")} className="insert-targets">{matches.map((entity, position) => <button id={'insert-target-' + entity.id} role="option" aria-selected={position === index} disabled={locked() || picker.invalid} key={entity.id} onClick={() => controller.insert(entity.id, label)}><span>{entity.title}</span><small>{entity.kind === 'view' ? snapshot?.tree[entity.collection]?.title + ' · ' + (entity.layout === 'table' ? t("表格") : entity.layout === 'cards' ? t("卡片") : t("列表")) : entity.kind === 'collection' ? t("集合") : entity.path}</small></button>)}{!matches.length && <p className="empty">{t("没有匹配的目标")}</p>}</div>
            {picker.kind === 'link' && /^(https?:\/\/|mailto:)/i.test(query) && <button className="primary" disabled={locked() || picker.invalid} onClick={() => controller.insert(query, label)}>{t("插入外部链接")}</button>}
            <p className="muted">{picker.kind === 'doc' ? t("嵌入显示原文，编辑时打开原页面。") : picker.kind === 'view' ? t("直接编辑原集合记录，不复制数据。") : t("链接保存稳定 ID，重命名不会改变指向。")}{t("不搜索共享灵感池。")}</p>
        </>}
    </section></div>, document.body);
}
export function EditorTools({ controller }: { controller: EditorToolsController }) {
    useSnapshot();
    const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
    const [, reposition] = useState(0);
    useEffect(() => { if (!state.slash) return; const move = () => reposition(value => value + 1); window.addEventListener('scroll', move, true); window.addEventListener('resize', move); return () => { window.removeEventListener('scroll', move, true); window.removeEventListener('resize', move); }; }, [!!state.slash]);
    const disabled = locked() || !state.editor;
    const format = state.editor?.selection.$from.parent;
    const selectedFormat = format?.type.name === 'heading' ? 'heading' + format.attrs.level : format?.type.name === 'code_block' ? 'code_block' : 'paragraph';
    const marks = state.editor?.storedMarks || state.editor?.selection.$from.marks() || [];
    const rect = controller.caret();
    const items = controller.slashItems();
    useEffect(() => { if (state.slash) document.getElementById('slash-command-' + items[state.slash.index]?.id)?.scrollIntoView({ block: 'nearest' }); }, [state.slash?.index, state.slash?.query]);
    return <><div className="editor-toolbar" role="toolbar" aria-label={t("正文编辑栏")} data-history-scope={controller.documentId}>
        {[['undo', t("撤销正文修改"), Undo2], ['redo', t("重做正文修改"), Redo2]].map(([id, title, Icon]: any) => <button key={id} aria-label={t(title)} title={t(title)} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => controller.run(id)}><Icon size={16}/></button>)}
        <span className="toolbar-divider"/>
        <select aria-label={t("段落格式")} disabled={disabled} value={selectedFormat} onChange={event => controller.run(event.target.value)}><option value="paragraph">{t("正文")}</option><option value="heading1">{t("一级标题")}</option><option value="heading2">{t("二级标题")}</option><option value="heading3">{t("三级标题")}</option><option value="code_block">{t("代码块")}</option></select>
        {[['bold', t("加粗"), Bold, 'strong'], ['italic', t("斜体"), Italic, 'emphasis']].map(([id, title, Icon, mark]: any) => <button key={id} title={t(title)} aria-label={t(title)} aria-pressed={marks.some(item => item.type.name === mark)} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => controller.run(id)}><Icon size={16}/></button>)}
        <select aria-label={t("更多正文格式")} disabled={disabled} value="" onChange={event => controller.run(event.target.value)}><option value="" disabled>{t("列表与更多")}</option><option value="bullet_list">{t("无序列表")}</option><option value="ordered_list">{t("有序列表")}</option><option value="blockquote">{t("引用")}</option><option value="hr">{t("分隔线")}</option></select>
        <span className="toolbar-divider"/>
        {[['link', t("链接"), Link2], ['view', t("嵌入视图"), Boxes], ['doc', t("嵌入文档"), FileText]].map(([id, title, Icon]: any) => <button key={id} disabled={disabled} title={title + (id === 'link' ? ' · Ctrl+Shift+K' : t(" · 输入 / 快捷插入"))} onMouseDown={event => event.preventDefault()} onClick={() => controller.run(id)}><Icon size={15}/><span>{t(title)}</span></button>)}
        <small>{t("输入 / 快捷插入")}</small>
    </div>{state.slash && rect && createPortal(<div id="slash-commands" className="slash-menu" role="listbox" aria-label={t("斜杠命令")} style={{ left: Math.max(8, Math.min(rect.left, window.innerWidth - 296)), top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 330)) }}>{items.map((command, index) => <button id={'slash-command-' + command.id} key={command.id} role="option" aria-selected={index === state.slash!.index} onMouseDown={event => event.preventDefault()} onClick={() => controller.run(command.id)}><span>{t(command.title)}</span><small>{t(command.group)}</small></button>)}{!items.length && <p className="empty">{t("没有匹配命令 · Esc 关闭")}</p>}<footer>{t("↑↓ 选择 · Enter 插入 · Esc 关闭")}</footer></div>, document.body)}{state.picker && <InsertPicker controller={controller} picker={state.picker}/>}</>;
}
