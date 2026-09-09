import { t } from './i18n';
import { useEffect, useState } from 'react';
import { api, reload, useSnapshot, notify, getSnapshot } from './state';
import { flushEditing, hasPendingInput } from './editing';
import { browserIdentity, currentBrowserIdentity } from './browserIdentity';

export function WriteControl() {
    const snapshot=useSnapshot();
    const [abandoned, setAbandoned] = useState<{ id: string; seen: number }[]>([]);
    useEffect(()=>{
        if(!snapshot) return;
        let stopped=false, sending=false, reportAgain=false;
        const report=async()=>{
            if(stopped)return;
            if(sending){reportAgain=true;return;}
            sending=true;
            try {
                const clientId = await browserIdentity;
                if(stopped)return;
                if(getSnapshot()?.control?.status==='pending') await flushEditing().catch(()=>{});
                const result=await api('/workspace/presence',{clientId,dirty:hasPendingInput(),ack:!hasPendingInput()?getSnapshot()?.control?.id:undefined},snapshot.project.id);
                if(stopped)return;
                setAbandoned(previous => JSON.stringify(previous) === JSON.stringify(result.abandonedClients || []) ? previous : result.abandonedClients || []);
                if(JSON.stringify(result.control)!==JSON.stringify(getSnapshot()?.control)) await reload();
            } catch { } finally {sending=false;if(reportAgain){reportAgain=false;void report();}}
        };
        const changed=()=>void report();
        window.addEventListener('editing-state',changed);
        void report();
        const timer=setInterval(()=>void report(),2000);
        const close=()=>{const clientId=currentBrowserIdentity();if(!clientId)return;void fetch('/api/workspace/presence',{method:'POST',keepalive:true,headers:{'content-type':'application/json','x-workbench-client':'web','x-project-id':snapshot.project.id},body:JSON.stringify({clientId,dirty:hasPendingInput(),close:true})});};
        const beforeUnload=(event:BeforeUnloadEvent)=>{if(hasPendingInput())event.preventDefault();};
        window.addEventListener('pagehide',close);window.addEventListener('beforeunload',beforeUnload);
        return ()=>{stopped=true;window.removeEventListener('editing-state',changed);clearInterval(timer);window.removeEventListener('pagehide',close);window.removeEventListener('beforeunload',beforeUnload);};
    },[snapshot?.actor.userId,snapshot?.project.id,snapshot?.control?.id,snapshot?.control?.status]);
    if(!snapshot) return null;
    const control=snapshot.control;
    const abandon = async (client: { id: string; seen: number }) => {
        if (!confirm(t('此页面已失联，可能仍有未保存输入。建议先回到原页面保存。确认放弃它对工作区的保护？这不会保存或删除原页面的本地恢复副本。'))) return;
        await api('/workspace/abandon-client', { clientId: client.id, seen: client.seen, confirm: true }, snapshot.project.id);
        setAbandoned(previous => previous.filter(item => item.id !== client.id));
        await reload();
    };
    return <>{abandoned.map(client => <div className="control-banner" key={client.id} role="status"><div><strong>{t('有失联页面的未保存输入')}</strong><span>{t('最后在线：')}{new Date(client.seen).toLocaleString()} · {client.id.slice(0,8)}</span></div><button disabled={!snapshot.actor.scopes.includes('workspace.write')} onClick={() => void abandon(client).catch(error => notify(error.message,true))}>{t('确认放弃此页面的未保存输入保护')}</button></div>)}{control && <div className="control-banner" role="status"><div><strong>{control.status==='pending'?t("正在交接控制权"):t("Agent 正在写入")}</strong><span>{control.status==='pending'?t("正在保存已有输入；未保存的弹窗请先完成或关闭。"):control.title+t(" · 可浏览，暂不可编辑")}</span></div><button onClick={()=>void api('/workspace/control',{action:'revoke',writeSessionId:control.id}).then(reload).catch(error=>notify(error.message,true))}>{t("收回控制权")}</button></div>}</>;
}
