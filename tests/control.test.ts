import { beforeAll,afterAll,beforeEach,afterEach,it,expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { Service } from '../src/server/service.js';
import { createCodec,type Codec } from '../src/server/codec.js';
import { seed } from '../src/server/seed.js';
import { capabilities } from '../src/server/auth.js';
import type { Actor,DesignObject } from '../src/shared/model.js';
let codec:Codec,store:Store,service:Service,directory:string,human:Actor,agent:Actor;
beforeAll(async()=>{codec=await createCodec();});


it('失联恢复接口需要人工确认且只操作当前账号工作区',async()=>{
 const {createApp}=await import('../src/server/app');
 const app=await createApp(service);
 try {
  const login=await app.inject({method:'POST',url:'/api/login',headers:{'x-workbench-client':'test'},payload:{username:'designer',password:'control-test-123'}});
  const headers={'x-workbench-client':'test',cookie:login.headers['set-cookie']!.toString().split(';')[0]};
  const clientId=randomUUID();
  await app.inject({method:'POST',url:'/api/workspace/presence',headers,payload:{clientId,dirty:true}});
  store.db.prepare('UPDATE web_clients SET seen=0 WHERE id=?').run(clientId);
  const presence=await app.inject({method:'POST',url:'/api/workspace/presence',headers,payload:{clientId:randomUUID(),dirty:false}});
  expect(presence.json().abandonedClients).toEqual([{id:clientId,seen:0}]);
  expect((await app.inject({method:'POST',url:'/api/workspace/abandon-client',headers,payload:{clientId,seen:0}})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:'/api/workspace/abandon-client',headers,payload:{clientId,seen:0,confirm:true}})).statusCode).toBe(200);
  expect(store.db.prepare('SELECT 1 FROM web_clients WHERE id=?').get(clientId)).toBeUndefined();
 } finally {await app.close();}
});


it('失联脏客户端只能由本人确认放弃，且拒绝过期确认',()=>{
 const clientId=randomUUID();service.control.presence(human,workspace(),{clientId,dirty:true});
 expect(()=>service.control.abandonClient(human,workspace(),{clientId,seen:0,confirm:true})).toThrow();
 store.db.prepare('UPDATE web_clients SET seen=0 WHERE id=?').run(clientId);
 expect(()=>write(agent,2,3)).toThrow('等待 Web');
 expect(()=>service.control.abandonClient(agent,workspace(),{clientId,seen:0,confirm:true})).toThrow('人工');
 expect(()=>service.control.abandonClient({...human,userId:'another-account'},workspace(),{clientId,seen:0,confirm:true})).toThrow('自己的');
 expect(()=>service.control.abandonClient({...human,scopes:[]},workspace(),{clientId,seen:0,confirm:true})).toThrow();
 expect(()=>service.control.abandonClient(human,workspace(),{clientId,seen:0,confirm:false})).toThrow();
 service.control.presence(human,workspace(),{clientId,dirty:true});
 expect(()=>service.control.abandonClient(human,workspace(),{clientId,seen:0,confirm:true})).toThrow();
 store.db.prepare('UPDATE web_clients SET seen=0 WHERE id=?').run(clientId);
 service.control.abandonClient(human,workspace(),{clientId,seen:0,confirm:true});
 expect(write(agent,2,3).writeSessionId).toBeTruthy();
 expect(cost()).toBe(3);
});
afterAll(async()=>{await codec.close();});
beforeEach(()=>{directory=mkdtempSync(join(tmpdir(),'workbench-control-'));store=new Store(directory);seed(store,'control-test-123');service=new Service(store,codec);const user=store.db.prepare("SELECT id FROM users WHERE username='designer'").get() as any;human={userId:user.id,username:'designer',projectId:'demo',kind:'human',sessionId:'human',scopes:capabilities,canSync:false};agent={...human,kind:'agent',sessionId:'agent-token'};});
afterEach(()=>{store.close();if(directory.startsWith(join(tmpdir(),'workbench-control-')))rmSync(directory,{recursive:true,force:true});});
function write(actor:Actor,expected:number,value:number,writeSessionId?:string,requestId=randomUUID()) {return service.execute(actor,{writeSessionId},()=>service.mutate(actor,requestId,[{type:'field',id:'frost',key:'cost',expected,value}])) as any;}
const workspace=()=>service.workspace(human).id;
const cost=()=> (service.snapshot(human).tree.frost as DesignObject).fields.cost;
it('首次修改获取会话，幂等重试不重复写入，结束后人工接手',()=>{
 const request=randomUUID(),first=write(agent,2,3,undefined,request);expect(first.writeSessionId).toBeTruthy();expect(write(agent,2,3,undefined,request).head).toBe(first.head);
 expect(()=>write(human,3,4)).toThrow('收回控制权');write(agent,3,4,first.writeSessionId);
 expect(service.history(human)).toHaveLength(1);
 service.control.action(agent,workspace(),{action:'release',writeSessionId:first.writeSessionId});write(human,4,5);expect(cost()).toBe(5);
});
it('首次写入校验失败不遗留活动锁',()=>{
 expect(()=>write(agent,99,3)).toThrow('字段已被修改');expect(service.snapshot(human).control).toBeNull();expect(cost()).toBe(2);
 expect(write(agent,2,3).writeSessionId).toBeTruthy();
});
it('旧版本撤销历史迁移后可重做，重启不重复导入',()=>{
 write(human,2,3);const group=service.history(human)[0].group_id;
 service.undo(human,'legacy-undo-request',group);
 store.db.prepare("UPDATE operations SET group_id=? WHERE group_id='history:legacy-undo-request'").run('undo:'+group+':legacy-undo-request');
 store.db.exec('DROP TABLE history_entries');service=new Service(store,codec);
 expect(service.history(human)[0].state).toBe('undone');service.historyStep(human,{requestId:randomUUID(),direction:'redo'});expect(cost()).toBe(3);
 service=new Service(store,codec);expect(service.history(human)).toHaveLength(1);
});
it('人工收回后旧会话、漏 ID、换任务标识都不能偷偷重新获取',()=>{
 const first=write(agent,2,3);service.control.action(human,workspace(),{action:'revoke',writeSessionId:first.writeSessionId});
 expect(()=>write(agent,3,4,first.writeSessionId)).toThrow('显式重新申请');expect(()=>write(agent,3,4)).toThrow('显式申请');
 expect(()=>service.execute(agent,{taskId:'pretend-new-task'},()=>({}))).toThrow('显式申请');
 expect(()=>service.control.action(agent,workspace(),{action:'renew',writeSessionId:first.writeSessionId})).toThrow();
 expect(()=>service.control.action(agent,workspace(),{action:'release',writeSessionId:first.writeSessionId})).toThrow();
 write(human,3,5);const next=service.control.action(agent,workspace(),{action:'request'}) as any;expect(next.writeSessionId).not.toBe(first.writeSessionId);
 expect(()=>write(agent,3,6,next.writeSessionId)).toThrow('字段已被修改');write(agent,5,6,next.writeSessionId);expect(cost()).toBe(6);
});
it('交接前等待每个 Web 保存并确认，离线脏输入不被过期清理',()=>{
 const first=randomUUID(),second=randomUUID();service.control.presence(human,workspace(),{clientId:first,dirty:true});service.control.presence(human,workspace(),{clientId:second,dirty:false});
 expect(()=>write(agent,2,3)).toThrow('等待 Web');expect(cost()).toBe(2);
 const session=service.control.current(workspace())!;
 store.db.prepare('UPDATE web_clients SET seen=0 WHERE id=?').run(first);
 expect(()=>write(agent,2,3)).toThrow('等待 Web');
 service.control.presence(human,workspace(),{clientId:first,dirty:false,ack:session.id});expect(()=>write(agent,2,3)).toThrow('等待 Web');
 service.control.presence(human,workspace(),{clientId:second,dirty:false,ack:session.id});expect(write(agent,2,3).writeSessionId).toBe(session.id);
});
it('过期与服务重启保留撤销标记，不接受其他 Agent 的会话',()=>{
 const first=write(agent,2,3);
 expect(()=>write({...agent,sessionId:'other-agent'},3,4,first.writeSessionId)).toThrow('不属于');
 store.db.prepare('UPDATE write_sessions SET expires=0 WHERE id=?').run(first.writeSessionId);
 expect(()=>write(agent,3,4,first.writeSessionId)).toThrow('超时');expect(service.snapshot(human).control).toBeNull();
 const next=service.control.action(agent,workspace(),{action:'request'}) as any;service.control.action(human,workspace(),{action:'revoke',writeSessionId:next.writeSessionId});
 store.close();store=new Store(directory);service=new Service(store,codec);expect(()=>write(agent,3,4)).toThrow('显式申请');
});
it('独立灵感池和其他账号不受个人工作区锁影响',()=>{
 write(agent,2,3);service.note(human,{requestId:randomUUID(),title:'灵感不锁',body:'独立便签',tags:[]});
 const user=store.db.prepare("SELECT id FROM users WHERE username='developer'").get() as any;const developer={...human,userId:user.id,username:'developer',sessionId:'developer'};
 write(developer,2,4);expect(cost()).toBe(3);expect(service.notes(human).some(note=>note.title==='灵感不锁')).toBe(true);
});
it('Agent 跨对象会话整体撤销重做，来源不影响历史顺序',()=>{
 const first=write(agent,2,3);const guide=service.snapshot(agent).tree.guide;
 if(guide.kind!=='object')throw Error('guide');
 service.execute(agent,{writeSessionId:first.writeSessionId},()=>service.mutate(agent,randomUUID(),[{type:'put',entity:{...guide,body:guide.body+'\n\nAgent 说明'},expected:guide}]));
 service.control.action(agent,workspace(),{action:'release',writeSessionId:first.writeSessionId});
 service.execute(human,{},()=>service.historyStep(human,{requestId:randomUUID(),direction:'undo',scope:'guide'}));expect(cost()).toBe(2);expect(service.snapshot(human).tree.guide).toEqual(guide);
 service.execute(human,{},()=>service.historyStep(human,{requestId:randomUUID(),direction:'redo',scope:'guide'}));expect(cost()).toBe(3);
 write(human,3,4);service.execute(human,{},()=>service.historyStep(human,{requestId:randomUUID(),direction:'undo',scope:'collections'}));expect(cost()).toBe(3);
 service.execute(human,{},()=>service.historyStep(human,{requestId:randomUUID(),direction:'undo',scope:'collections'}));expect(cost()).toBe(2);
});
it('新修改废弃重做分支，选择性撤销拒绝覆盖后续冲突',()=>{
 write(human,2,3);const group=service.history(human)[0].group_id;write(human,3,4);
 expect(()=>service.historyStep(human,{requestId:randomUUID(),direction:'undo',groupId:group})).toThrow('冲突');
 service.historyStep(human,{requestId:randomUUID(),direction:'undo'});expect(cost()).toBe(3);write(human,3,5);
 expect(()=>service.historyStep(human,{requestId:randomUUID(),direction:'redo'})).toThrow('没有可重做');expect(cost()).toBe(5);
});
