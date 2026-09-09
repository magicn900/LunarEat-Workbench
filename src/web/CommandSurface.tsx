import { t } from './i18n';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal, Search, X } from 'lucide-react';
import { editorCommands } from './editorCommandRegistry';
import { commands, dispatch, execute, type Command, type Target } from './commands';
import { flushEditing, stepHistory } from './editing';
import { navigate, notify, useSnapshot } from './state';

type Menu = { target: Target; x: number; y: number; anchor: HTMLElement; scope?: string };
const textInput=(element:HTMLElement)=>!!element.closest('input,textarea,select')||element.isContentEditable;
const targetAt=(element:HTMLElement):Target=>{
    const target=element.closest<HTMLElement>('[data-entity-id],[data-directory-path]');
    return target?.dataset.entityId?{id:target.dataset.entityId}:target?.dataset.directoryPath?{directory:target.dataset.directoryPath}:{};
};
export function EntityMenuButton({ id, title, directory }: { id?: string; title: string; directory?: string }) {
    return <button className="icon more-actions" aria-label={t("更多操作 ")+title} aria-haspopup="menu" onClick={event=>{event.preventDefault();event.stopPropagation();const anchor=event.currentTarget;const rect=anchor.getBoundingClientRect();dispatch('command-menu',{target:{id,directory},x:rect.right,y:rect.bottom,anchor,scope:anchor.closest<HTMLElement>('[data-history-scope]')?.dataset.historyScope});}}><MoreHorizontal size={17}/></button>;
}
export function CommandSurface({ scope }: { scope?: string }) {
    const snapshot=useSnapshot();
    const [menu,setMenu]=useState<Menu|null>(null),[palette,setPalette]=useState(false),[query,setQuery]=useState(''),[help,setHelp]=useState(false);
    const panel=useRef<HTMLDivElement>(null),lastTarget=useRef<Target>({});
    const lastScope=useRef(scope);
    const close=()=>{const anchor=menu?.anchor;setMenu(null);queueMicrotask(()=>{if(anchor?.isConnected)anchor.focus();});};
    useEffect(()=>{
        lastScope.current=scope;
        const open=(event:Event)=>{setMenu((event as CustomEvent).detail);};
        const context=(event:MouseEvent)=>{
            const element=event.target as HTMLElement;
            if(textInput(element)||element.closest('[role="dialog"],[role="menu"]'))return;
            const target=targetAt(element);
            if(!target.id&&!target.directory)return;
            event.preventDefault();lastTarget.current=target;
            setMenu({target,x:event.clientX,y:event.clientY,anchor:element.closest<HTMLElement>('[data-entity-id],[data-directory-path]')!,scope:element.closest<HTMLElement>('[data-history-scope]')?.dataset.historyScope||scope});
        };
        const select=(event:Event)=>{const target=event.target as HTMLElement;if(!target.closest('[role="menu"],[role="dialog"]')){lastTarget.current=targetAt(target);lastScope.current=target.closest<HTMLElement>('[data-history-scope]')?.dataset.historyScope||scope;}};
        const key=(event:KeyboardEvent)=>{
            if(event.isComposing||event.keyCode===229)return;
            const element=event.target as HTMLElement;
            const modifier=event.ctrlKey||event.metaKey;
            if(event.key==='Escape'){setMenu(null);setPalette(false);setHelp(false);return;}
            if(!event.shiftKey&&modifier&&event.key.toLowerCase()==='k'){event.preventDefault();setQuery('');setPalette(true);return;}
            if(modifier&&event.key.toLowerCase()==='s'){event.preventDefault();if(!scope){notify(t("此页面不使用工作区保存，请使用页面中的保存按钮"));return;}void flushEditing().then(()=>notify(t("当前编辑已保存，不会自动发布"))).catch(error=>notify(error.message,true));return;}
            if(modifier&&event.key.toLowerCase()==='f'&&event.shiftKey){event.preventDefault();dispatch('workbench-search');return;}
            if(modifier&&event.key.toLowerCase()==='f'&&element.closest('.document-editor')){event.preventDefault();dispatch('document-find');return;}
            if(element.closest('[role="dialog"],[role="menu"]'))return;
            const inNativeInput=!!element.closest('input,textarea,select');
            const activeScope=element.closest<HTMLElement>('[data-history-scope]')?.dataset.historyScope||lastScope.current||scope;
            if(modifier&&['z','y'].includes(event.key.toLowerCase())&&!inNativeInput&&!!activeScope){event.preventDefault();event.stopImmediatePropagation();void stepHistory(event.key.toLowerCase()==='y'||event.shiftKey?'redo':'undo',activeScope);return;}
            if(textInput(element))return;
            if(event.key==='F10'&&event.shiftKey){const target=targetAt(element);if(!target.id&&!target.directory)return;event.preventDefault();const rect=element.getBoundingClientRect();setMenu({target,x:rect.left,y:rect.bottom,anchor:element,scope:activeScope});return;}
            if(event.key==='F2'||event.key==='Delete'){
                const target=targetAt(element);
                if(!target.id&&!target.directory)return;
                const command=commands(target,activeScope).find(command=>command.id===(event.key==='F2'?'rename':'delete'));
                if(command){event.preventDefault();void execute(command);}
            }
        };
        window.addEventListener('command-menu',open);document.addEventListener('contextmenu',context);document.addEventListener('focusin',select);document.addEventListener('pointerdown',select);window.addEventListener('keydown',key,true);
        return()=>{window.removeEventListener('command-menu',open);document.removeEventListener('contextmenu',context);document.removeEventListener('focusin',select);document.removeEventListener('pointerdown',select);window.removeEventListener('keydown',key,true);};
    },[scope]);
    useLayoutEffect(()=>{
        if(!menu||!panel.current)return;
        const bounds=panel.current.getBoundingClientRect();
        panel.current.style.left=Math.max(8,Math.min(menu.x,window.innerWidth-bounds.width-8))+'px';
        panel.current.style.top=Math.max(8,Math.min(menu.y,window.innerHeight-bounds.height-8))+'px';
        panel.current.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    },[menu]);
    useEffect(()=>{if(!menu)return;const closeMenu=()=>setMenu(null);window.addEventListener('resize',closeMenu);window.addEventListener('wheel',closeMenu);return()=>{window.removeEventListener('resize',closeMenu);window.removeEventListener('wheel',closeMenu);};},[menu]);
    if(!snapshot)return null;
    const shortcuts:Command[]=[{id:'save',label:'保存当前编辑',shortcut:'Ctrl+S',run:()=>flushEditing().then(()=>notify(t("已保存")))},{id:'search',label:'搜索工作区',shortcut:'Ctrl+Shift+F',run:()=>dispatch('workbench-search')},{id:'help',label:'快捷键说明',run:()=>setHelp(true)}];
    const paletteItems:Command[]=[...commands(lastTarget.current,scope),...shortcuts,...(snapshot.tree[scope || '']?.kind === 'object' ? editorCommands.map(command => ({id:'editor-'+command.id,label:t('正文：')+t(command.title),disabled:!!snapshot.control,run:()=>dispatch('editor-command',{id:command.id,documentId:scope})})) : []),...Object.values(snapshot.tree).filter(entity=>entity.kind==='object').map(entity=>({id:'open-'+entity.id,label:t('打开：')+entity.title,run:()=>navigate(entity.id)}))].filter(command=>t(command.label).toLowerCase().includes(query.toLowerCase()));
    const moveFocus=(event:React.KeyboardEvent)=>{
        const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index=buttons.indexOf(document.activeElement as HTMLButtonElement);
        if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;buttons[next]?.focus();}
        if(event.key==='Tab'&&menu){event.preventDefault();close();}
        if(event.key==='Escape'){event.preventDefault();close();}
    };
    return <><button className="command-launcher" title={t("命令面板 Ctrl+K")} onClick={()=>{setQuery('');setPalette(true);}}><Search size={14}/>{t("命令")} <kbd>Ctrl K</kbd></button>{menu&&createPortal(<div className="menu-overlay" onPointerDown={event=>{if(event.target===event.currentTarget)close();}}><div ref={panel} role="menu" aria-label={t("对象操作")} className="context-menu" style={{left:menu.x,top:menu.y}} onKeyDown={moveFocus}>{commands(menu.target,menu.scope).map(command=><button role="menuitem" key={command.id} disabled={command.disabled} className={command.danger?'menu-danger':''} onClick={()=>{close();void execute(command);}}><span>{t(command.label)}</span>{command.shortcut&&<kbd>{command.shortcut}</kbd>}</button>)}</div></div>,document.body)}{(palette||help)&&createPortal(<div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget){setPalette(false);setHelp(false);}}}><section role="dialog" aria-modal="true" aria-label={help?t("快捷键说明"):t("命令面板")} className="modal command-palette" onKeyDown={event=>{if(event.key==='Tab'){const items=[...event.currentTarget.querySelectorAll<HTMLElement>('input,button:not(:disabled)')];const next=event.shiftKey?items.at(-1):items[0];if(document.activeElement===(event.shiftKey?items[0]:items.at(-1))){event.preventDefault();next?.focus();}}}}><header><h2>{help?t("快捷键说明"):t("命令面板")}</h2><button aria-label={t("关闭")} onClick={()=>{setPalette(false);setHelp(false);}}><X size={16}/></button></header>{help?<dl className="shortcut-list">{[['Ctrl+Z',t("撤销当前上下文最近修改（含 Agent）")],['Ctrl+Shift+Z / Ctrl+Y',t("重做")],['Ctrl+S',t("保存当前编辑，不发布")],['Ctrl+K',t("命令与页面搜索")],['Ctrl+Shift+K',t("插入或修改正文链接")],['Ctrl+F',t("正文查找；其他区域保留浏览器查找")],['Ctrl+Shift+F',t("搜索工作区，不包含灵感池")],['F2 / Delete',t("重命名 / 删除聚焦对象")],['Shift+F10',t("打开聚焦对象的菜单")],['Esc',t("关闭菜单与弹窗")]].map(([key,value])=><div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}<p>{t("Mac 使用 Cmd。文字输入框保留原生撤销、复制粘贴；中文组合输入期间不触发对象操作。")}</p></dl>:<><input aria-label={t("搜索命令与页面")} autoFocus value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&paletteItems[0]){setPalette(false);void execute(paletteItems[0]);}if(event.key==='ArrowDown'){event.preventDefault();event.currentTarget.parentElement?.querySelector<HTMLButtonElement>('.palette-results button:not(:disabled)')?.focus();}}}/><div className="palette-results" onKeyDown={moveFocus}>{paletteItems.map(command=><button key={command.id} disabled={command.disabled} onClick={()=>{setPalette(false);void execute(command);}}>{t(command.label)}{'shortcut' in command&&<kbd>{command.shortcut}</kbd>}</button>)}{!paletteItems.length&&<p className="empty">{t("没有匹配的命令或页面")}</p>}</div></>}</section></div>,document.body)}</>;
}
