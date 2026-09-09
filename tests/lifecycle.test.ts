import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/server/store.js';
import { createCodec, type Codec } from '../src/server/codec.js';
import { Service } from '../src/server/service.js';
import { createApp } from '../src/server/app.js';
import { seed } from '../src/server/seed.js';
import { passwordHash, actorFor } from '../src/server/auth.js';
import { updateAccountAccess } from '../src/server/administration.js';
import { Lifecycle } from '../src/server/lifecycle.js';
let store: Store, codec: Codec, service: Service, app: Awaited<ReturnType<typeof createApp>>, directory: string, cookie: string, designer: string, developer: string;
const password = 'lifecycle-test-password';
const headers = (session = cookie) => ({ cookie: session, 'x-workbench-client': 'test' });
const post = (path: string, payload: Record<string, unknown>, session = cookie) => app.inject({ method:'POST', url:'/api'+path, headers:headers(session), payload });
const get = (path: string, session = cookie) => app.inject({ url:'/api'+path, headers:headers(session) });
const login = async (username: string) => { const response=await post('/login',{username,password},''); expect(response.statusCode).toBe(200); return response.headers['set-cookie']!.toString().split(';')[0]; };
const preview = async (kind: string, id: string, projectId?: string) => (await get('/admin/impact?'+new URLSearchParams({kind,id,...(projectId?{projectId}:{})}))).json();
const remove = (impact: any) => post('/admin/remove',{kind:impact.kind,id:impact.id,projectId:impact.projectId,name:impact.name,expected:impact.expected});
const project = async () => { const response=await post('/admin/projects',{name:'独立验证项目'}); expect(response.statusCode).toBe(200); return response.json(); };
const userId = (name: string) => (store.db.prepare('SELECT id FROM users WHERE username=?').get(name) as any).id;
const archive = (id='demo', version=0) => post('/admin/project',{id,version,action:'archive'});
beforeAll(async()=>{ codec=await createCodec(); },30000);
afterAll(async()=>{await codec.close();});
beforeEach(async()=>{ directory=mkdtempSync(join(tmpdir(),'workbench-lifecycle-'));store=new Store(directory);seed(store,password);store.db.prepare('INSERT INTO users VALUES (?,?,?)').run('admin','admin',passwordHash(password));store.db.transaction(()=>updateAccountAccess(store,'fixture','admin',true,false))();service=new Service(store,codec);app=await createApp(service);cookie=await login('admin');designer=await login('designer');developer=await login('developer'); });
afterEach(async()=>{await app.close();store.close();if(directory.startsWith(join(tmpdir(),'workbench-lifecycle-')))rmSync(directory,{recursive:true,force:true});});
it('管理员创建多个空项目不自动授权，重命名拒绝旧版本',async()=>{
    const first=await project(),second=await project();expect(first.id).not.toBe(second.id);expect(store.main(first.id)).not.toBe(store.main(second.id));
    expect((await get('/identity')).json().projects).toEqual([]);expect((await get('/admin')).json().members.filter((member:any)=>member.projectId===first.id)).toEqual([]);
    expect((await post('/admin/project',{id:first.id,version:0,action:'rename',name:'已重命名'})).statusCode).toBe(200);
    expect((await archive(first.id,0)).statusCode).toBe(409);
});
it('所有管理写接口拒绝普通用户、Agent和跨站请求',async()=>{
    const token=(await post('/tokens',{name:'agent',scopes:['workspace.read','workspace.write']},designer)).json().token;
    for(const path of ['/admin/projects','/admin/project','/admin/remove']) {
        expect((await post(path,{},designer)).statusCode).toBe(403);
        expect((await app.inject({method:'POST',url:'/api'+path,headers:{authorization:'Bearer '+token},payload:{}})).statusCode).toBe(403);
        expect((await app.inject({method:'POST',url:'/api'+path,headers:{...headers(),origin:'https://evil.example'},payload:{}})).statusCode).toBe(403);
    }
    expect((await get('/admin/impact?kind=account&id=admin',designer)).statusCode).toBe(403);
});
it('归档保留授权和内容，但旧Web与Agent不能编辑、发布、确认同步或写便签；恢复后有效',async()=>{
    await get('/workspace',designer); const before=(await get('/workspace',designer)).json();const actor=actorFor(store,designer.split('=')[1],false,'demo');
    const token=(await post('/tokens',{name:'archived-agent',scopes:['workspace.read','workspace.write','inspiration.write']},designer)).json().token;
    expect((await archive()).statusCode).toBe(200);const after=(await get('/workspace',designer)).json();expect(after.tree).toEqual(before.tree);expect(after.workspace).toEqual(before.workspace);expect(after.main).toBe(before.main);expect(after.actor.scopes).toEqual(['workspace.read','inspiration.read']);
    const entry=Object.values(before.tree)[0] as any;
    const calls:[string,Record<string, unknown>,string][]=[['/workspace/operations',{requestId:randomUUID(),operations:[{type:'delete',id:entry.id,expected:entry}]},designer],['/publish',{requestId:randomUUID(),head:before.workspace.head,main:before.main,title:'归档',description:''},designer],['/inspiration',{requestId:randomUUID(),title:'归档便签',body:'',tags:[]},designer]];
    for(const [path,payload,session] of calls) expect((await post(path,payload,session)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await app.inject({method:'POST',url:'/api/workspace/control',headers:{authorization:'Bearer '+token},payload:{action:'request',taskId:'archived'}})).statusCode).toBe(409);
    expect(()=>service.mutate(actor,randomUUID(),[{type:'delete',id:entry.id,expected:entry}])).toThrow('归档');
    expect((await get('/identity',developer)).json().projects[0].scopes).not.toContain('design.sync');
    expect((await post('/admin/project',{id:'demo',version:1,action:'restore'})).statusCode).toBe(200);expect((await get('/identity',designer)).json().projects[0].scopes).toContain('workspace.write');
});
it('归档和删除必须尊重未保存输入与活动Agent会话',async()=>{
    const workspace=(await get('/workspace',designer)).json().workspace;store.db.prepare('INSERT INTO web_clients VALUES (?,?,?,?,?)').run('dirty',workspace.id,1,Date.now(),null);
    expect((await archive()).statusCode).toBe(409);const impact=await preview('account',userId('designer'));expect(impact.blockers.join()).toContain('未保存');expect((await remove(impact)).statusCode).toBe(409);
    store.db.prepare('DELETE FROM web_clients').run();const token=(await post('/tokens',{name:'active-agent',scopes:['workspace.read','workspace.write']},designer)).json().token;
    expect((await app.inject({method:'POST',url:'/api/workspace/control',headers:{authorization:'Bearer '+token},payload:{action:'request',taskId:'active'}})).statusCode).toBe(200);
    expect((await archive()).statusCode).toBe(409);expect((await preview('account',userId('designer'))).blockers.join()).toContain('Agent');
});
it('删除账号拒绝自己、最后管理员、未发布草稿和过期影响预览',async()=>{
    const current=await preview('account','admin');expect(current.blockers.join()).toContain('当前登录');expect(current.blockers.join()).toContain('管理员');expect((await remove(current)).statusCode).toBe(409);
    const before=await preview('account',userId('designer'));await post('/tokens',{name:'changed-impact',scopes:['workspace.read']},designer);expect((await remove(before)).statusCode).toBe(409);
    const actor=actorFor(store,designer.split('=')[1],false,'demo');const workspace=service.workspace(actor);const tree=store.tree(workspace.head);const entry=Object.values(tree).find(entity=>entity.kind==='object')!;service.mutate(actor,randomUUID(),[{type:'put',expected:entry,entity:{...entry,title:'未发布内容'}}]);
    const impact=await preview('account',userId('designer'));expect(impact.counts.unpublished).toBe(1);expect((await remove(impact)).statusCode).toBe(409);expect((await get('/identity',designer)).statusCode).toBe(200);
});
it('删除干净账号撤销会话凭据，保留共享内容、署名与其他账号，名称不复用',async()=>{
    const before=(await get('/workspace',designer)).json();const actor=actorFor(store,designer.split('=')[1],false,'demo');const token=(await post('/tokens',{name:'removed-agent',scopes:['workspace.read']},designer)).json().token;
    const notes=JSON.stringify(service.notes(actor));const main=store.main('demo');const impact=await preview('account',userId('designer'));expect(impact.blockers).toEqual([]);expect((await remove(impact)).statusCode).toBe(200);
    expect((await get('/identity',designer)).statusCode).toBe(401);expect((await app.inject({url:'/api/workspace',headers:{authorization:'Bearer '+token}})).statusCode).toBe(401);expect((await get('/identity',developer)).statusCode).toBe(200);
    expect(store.main('demo')).toBe(main);expect(store.tree(before.workspace.head)).toEqual(before.tree);expect(JSON.stringify(service.notes(actor))).toBe(notes);expect((await get('/admin')).json().users.some((user:any)=>user.username==='designer')).toBe(false);expect((await post('/admin/users',{username:'designer',password})).statusCode).toBe(409);
});
it('移出项目保留草稿，重新加入恢复原工作区且旧凭据不复活',async()=>{
    const before=(await get('/workspace',designer)).json().workspace;const token=(await post('/tokens',{name:'member-agent',scopes:['workspace.read']},designer)).json().token;
    const impact=await preview('member',userId('designer'),'demo');expect((await remove(impact)).statusCode).toBe(200);expect((await get('/workspace',designer)).statusCode).toBe(403);
    expect((await post('/admin/member',{userId:userId('designer'),projectId:'demo',scopes:['workspace.read'],expectedScopes:null})).statusCode).toBe(200);expect((await get('/workspace',designer)).json().workspace).toEqual(before);expect((await app.inject({url:'/api/workspace',headers:{authorization:'Bearer '+token}})).statusCode).toBe(401);
});
it('删除项目要求先归档与名称确认，删除后恢复和直接访问都拒绝，其他项目不变',async()=>{
    const other=await project();const main=store.main('demo');const before=await preview('project',other.id);expect((await remove(before)).statusCode).toBe(409);expect((await archive(other.id)).statusCode).toBe(200);
    expect((await post('/admin/member',{userId:userId('designer'),projectId:other.id,scopes:['workspace.read'],expectedScopes:null})).statusCode).toBe(200);
    const impact=await preview('project',other.id);expect((await post('/admin/remove',{kind:'project',id:other.id,name:'错误名称',expected:impact.expected})).statusCode).toBe(400);expect((await remove(impact)).statusCode).toBe(200);
    expect((await get('/admin')).json().projects.some((project:any)=>project.id===other.id)).toBe(false);expect((await get('/identity',designer)).json().projects.some((project:any)=>project.id===other.id)).toBe(false);expect((await post('/admin/project',{id:other.id,version:2,action:'restore'})).statusCode).toBe(404);expect((await app.inject({url:'/api/workspace',headers:{...headers(designer),'x-project-id':other.id}})).statusCode).toBe(404);expect(store.main('demo')).toBe(main);
});
it('审计失败时删除在同一事务内回滚',async()=>{
    const lifecycle=new Lifecycle(store),target={kind:'account' as const,id:userId('designer')};const impact=lifecycle.preview(target,'admin');store.db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'test audit failure'); END");
    expect(()=>lifecycle.remove(target,{id:'admin',username:'admin'},impact.name,impact.expected)).toThrow('test audit failure');expect((await get('/identity',designer)).statusCode).toBe(200);expect(store.db.prepare('SELECT * FROM deleted_accounts').all()).toEqual([]);
});
