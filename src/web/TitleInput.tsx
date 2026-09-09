import { t } from './i18n';
import { useEffect, useRef, useState } from 'react';
import type { DesignObject } from '../shared/model';
import { put, notify, useSnapshot } from './state';
import { locked, registerBuffer, editingChanged } from './editing';
export function TitleInput({ object }: { object: DesignObject }) {
    useSnapshot();
    const [title,setTitle]=useState(object.title),[dirty,setDirty]=useState(false);
    const baseline=useRef(object);
    const state=useRef({title,object}); state.current={title,object:baseline.current};
    const saving=useRef<Promise<void>|null>(null);
    useEffect(()=>{if(!dirty){baseline.current=object;state.current.object=object;setTitle(object.title);editingChanged();}},[object,dirty]);
    const save=()=>{
        if(saving.current)return saving.current;
        const current=state.current;
        if(current.title===current.object.title)return Promise.resolve();
        saving.current=put({...current.object,title:current.title},current.object).then(()=>{setDirty(false);}).finally(()=>{saving.current=null;editingChanged();});
        return saving.current;
    };
    useEffect(()=>registerBuffer('title:'+object.id,{dirty:()=>!!saving.current||state.current.title!==state.current.object.title,flush:save}),[object.id]);
    return <input className="page-title" aria-label={t("页面标题")} readOnly={locked()} value={title} onChange={event=>{state.current.title=event.target.value;setDirty(true);setTitle(event.target.value);editingChanged();}} onBlur={()=>void save().catch(error=>notify(error.message,true))}/>;
}
