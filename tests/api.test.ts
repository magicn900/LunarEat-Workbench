import { beforeAll,afterAll,it,expect } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { createCodec,type Codec } from '../src/server/codec.js';
import { Service } from '../src/server/service.js';
import { createApp } from '../src/server/app.js';
import { seed } from '../src/server/seed.js';
let store:Store,codec:Codec,app:Awaited<ReturnType<typeof createApp>>,directory:string,session:string;
const headers=()=>({'x-workbench-client':'test',cookie:session});
beforeAll(async()=>{directory=mkdtempSync(join(tmpdir(),'design-workbench-api-'));store=new Store(directory);seed(store,'api-password-123');codec=await createCodec();app=await createApp(new Service(store,codec));const response=await app.inject({method:'POST',url:'/api/login',headers:{'x-workbench-client':'test'},payload:{username:'designer',password:'api-password-123'}});session=response.headers['set-cookie']!.toString().split(';')[0];});
afterAll(async()=>{await app.close();await codec.close();store.close();if(directory.startsWith(join(tmpdir(),'design-workbench-api-')))rmSync(directory,{recursive:true,force:true});});
it('未登录请求被拒绝，不泄露项目内容',async()=>{const response=await app.inject('/api/workspace');expect(response.statusCode).toBe(401);});
it('跨站修改被拒绝',async()=>{const response=await app.inject({method:'POST',url:'/api/inspiration',headers:{...headers(),origin:'https://untrusted.example'},payload:{}});expect(response.statusCode).toBe(403);});
it('非法操作结构返回 400 而不执行',async()=>{const response=await app.inject({method:'POST',url:'/api/workspace/operations',headers:headers(),payload:{requestId:'invalid',operations:[{type:'field',id:'frost'}]}});expect(response.statusCode).toBe(400);});
it('token 不能提升权限，撤销后立即失效',async()=>{let response=await app.inject({method:'POST',url:'/api/tokens',headers:headers(),payload:{name:'forbidden',scopes:['design.sync']}});expect(response.statusCode).toBe(403);response=await app.inject({method:'POST',url:'/api/tokens',headers:headers(),payload:{name:'reader',scopes:['workspace.read']}});expect(response.statusCode).toBe(200);const issued=response.json();expect((await app.inject({url:'/api/inspiration',headers:{authorization:'Bearer '+issued.token}})).statusCode).toBe(403);await app.inject({method:'POST',url:'/api/tokens/revoke',headers:headers(),payload:{id:issued.id}});expect((await app.inject({url:'/api/workspace',headers:{authorization:'Bearer '+issued.token}})).statusCode).toBe(401);});
it('导入预览使用服务端 codec，且不保存草稿',async()=>{const before=(await app.inject({url:'/api/workspace',headers:headers()})).json();const response=await app.inject({method:'POST',url:'/api/workspace/import-preview',headers:headers(),payload:{id:'import-example',kind:'object',path:'导入/example.md',title:'示例',collection:null,fields:{},body:'# 标题\n\n- 项目'}});expect(response.statusCode).toBe(200);expect(response.json().text).toContain('id: import-example');expect((await app.inject({url:'/api/workspace',headers:headers()})).json().workspace.head).toBe(before.workspace.head);});
it('所有草稿写接口受控制权保护，错误明确区分人工收回与未申请',async()=>{
 const issued=(await app.inject({method:'POST',url:'/api/tokens',headers:headers(),payload:{name:'control-api',scopes:['workspace.read','workspace.write']}})).json();
 const agentHeaders={authorization:'Bearer '+issued.token};
 const snapshot=(await app.inject({url:'/api/workspace',headers:headers()})).json();
 const mutation={requestId:'api-agent-write',operations:[{type:'field',id:'frost',key:'cost',expected:snapshot.tree.frost.fields.cost,value:11}]};
 const first=await app.inject({method:'POST',url:'/api/workspace/operations',headers:agentHeaders,payload:mutation});expect(first.statusCode).toBe(200);
 const writeSessionId=first.json().writeSessionId;
 for(const [url,payload] of [
  ['/api/workspace/operations',{requestId:'human-blocked',operations:mutation.operations}],
  ['/api/workspace/undo',{requestId:'undo-blocked',groupId:'unknown'}],
  ['/api/changes/withdraw',{id:'unused',revision:snapshot.main}],
  ['/api/workspace/history-step',{requestId:'redo-blocked',direction:'redo'}],
  ['/api/documents/overview/steps',{requestId:'steps-blocked',schemaVersion:4,version:0,steps:[{}],clientId:'web',groupId:'web'}],
  ['/api/publish',{requestId:'publish-blocked',head:snapshot.workspace.head,main:snapshot.main,title:'不可发布'}],
  ['/api/workspace/refresh',{requestId:'refresh-blocked',head:snapshot.workspace.head,main:snapshot.main}],
  ['/api/workspace/discard',{requestId:'discard-blocked',head:snapshot.workspace.head,base:snapshot.workspace.base,main:snapshot.main,targets:[{id:'frost'}]}],
  ['/api/inspiration/promote',{requestId:'promote-blocked',id:'unused',version:1}]
 ] as const){const result=await app.inject({method:'POST',url,headers:headers(),payload});expect(result.statusCode,url).toBe(409);expect(result.json().code,url).toBe('WORKSPACE_LOCKED');}
 expect((await app.inject({method:'POST',url:'/api/workspace/control',headers:headers(),payload:{action:'revoke',writeSessionId}})).statusCode).toBe(200);
 for(const extra of [{writeSessionId},{},{taskId:'different-run'}]){
  const denied=await app.inject({method:'POST',url:'/api/workspace/operations',headers:agentHeaders,payload:{...mutation,...extra,requestId:'denied-'+JSON.stringify(extra)}});
  expect(denied.statusCode).toBe(409);expect(denied.json().code).toBe('WRITE_SESSION_REVOKED');expect(denied.json().requiredAction).toBe('request_new_write_session');
 }
 const preview=(await app.inject({url:'/api/publish/preview',headers:headers()})).json();
 const discardInput={requestId:'revoked-discard',head:preview.head,base:preview.base,main:preview.main,targets:[{id:'frost'}]};
 for(const extra of [{writeSessionId},{}]){
  const denied=await app.inject({method:'POST',url:'/api/workspace/discard',headers:agentHeaders,payload:{...discardInput,...extra}});
  expect(denied.statusCode).toBe(409);expect(denied.json().code).toBe('WRITE_SESSION_REVOKED');
 }
 const reader=(await app.inject({method:'POST',url:'/api/tokens',headers:headers(),payload:{name:'discard-reader',scopes:['workspace.read']}})).json();
 const readerHeaders={authorization:'Bearer '+reader.token};
 expect((await app.inject({method:'POST',url:'/api/workspace/discard-preview',headers:readerHeaders,payload:discardInput})).statusCode).toBe(200);
 expect((await app.inject({method:'POST',url:'/api/workspace/discard',headers:readerHeaders,payload:discardInput})).statusCode).toBe(403);
 expect((await app.inject({url:'/api/workspace',headers:headers()})).json().tree.frost.fields.cost).toBe(11);
});
