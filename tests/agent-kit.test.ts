import { beforeAll, afterAll, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { Store } from '../src/server/store.js';
import { createCodec } from '../src/server/codec.js';
import { Service } from '../src/server/service.js';
import { createApp } from '../src/server/app.js';
import { seed } from '../src/server/seed.js';
import { actorFor, issueToken } from '../src/server/auth.js';

const execute = promisify(execFile);
let directory: string, store: Store, codec: Awaited<ReturnType<typeof createCodec>>, service: Service, app: Awaited<ReturnType<typeof createApp>>, url: string, token: string, human: ReturnType<typeof actorFor>;
const script = resolve('public/skills/lunareat-workbench/scripts/agent.mjs');
const invoke = async (args: string[], overrides: Record<string,string> = {}) => {
    try { const result = await execute(process.execPath, [script, ...args], { env: { ...process.env, WORKBENCH_CONFIG_HOME: join(directory,'config'), WORKBENCH_TOKEN: token, ...overrides } }); return JSON.parse(result.stdout); }
    catch (error: any) { return JSON.parse(error.stdout); }
};
const input = (name: string, data: unknown) => { const file=join(directory,name+'.json');writeFileSync(file,JSON.stringify(data));return file; };
beforeAll(async()=>{
    directory=mkdtempSync(join(tmpdir(),'workbench-agent-kit-'));store=new Store(join(directory,'data'));seed(store,'agent-kit-password');codec=await createCodec();service=new Service(store,codec);app=await createApp(service);url=await app.listen({port:0,host:'127.0.0.1'});
    const user=store.db.prepare("SELECT id FROM users WHERE username='designer'").get() as {id:string};
    store.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(store.hash('test-human'),user.id,Date.now()+600000);human=actorFor(store,'test-human',false,'demo');token=issueToken(store,human,'kit test',['workspace.read','workspace.write']).token;
},30000);
afterAll(async()=>{await app.close();await codec.close();store.close();const absolute=resolve(directory);if(absolute.startsWith(resolve(tmpdir())+requireSeparator()) && absolute.includes('workbench-agent-kit-'))rmSync(absolute,{recursive:true,force:true});});
function requireSeparator(){return process.platform==='win32'?'\\':'/';}
it('公开 kit 清单校验所有文件，不泄露服务器路径，connect 只读且需要 Agent 身份',async()=>{
    const manifest=(await app.inject('/api/agent/kit/manifest.json')).json();expect(manifest.connect).toBe('/api/agent/connect');
    for(const file of manifest.files){const response=await app.inject('/api/agent/kit/'+file.path);expect(response.statusCode).toBe(200);expect(createHash('sha256').update(response.rawPayload).digest('hex')).toBe(file.sha256);}
    expect((await app.inject('/api/agent/kit/unknown')).statusCode).toBe(404);
    expect((await app.inject({method:'POST',url:'/api/agent/connect',payload:{},headers:{'x-workbench-client':'test'}})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url:'/api/agent/connect',payload:{},headers:{cookie:'session=test-human'}})).statusCode).toBe(403);
    const before=store.db.prepare('SELECT * FROM workspaces').all();
    const checked=(await app.inject({method:'POST',url:'/api/agent/connect',payload:{},headers:{authorization:'Bearer '+token}})).json();expect(checked.account.username).toBe('designer');expect(checked.project.id).toBe('demo');expect(checked.control).toBeNull();expect(checked.tree).toBeUndefined();expect(store.db.prepare('SELECT * FROM workspaces').all()).toEqual(before);
    const settings=(await app.inject({url:'/api/settings',headers:{cookie:'session=test-human'}})).json();expect(settings.mcp).toBeUndefined();expect(settings.connection.manifest).toBe('/api/agent/kit/manifest.json');
});
it('远程 HTTP 仅显式授权指定地址，缺少凭据不请求且不能复用到其他地址', async () => {
    const configHome = join(directory, 'http-config');
    const probe = join(directory, 'http-requests.json');
    const mock = join(directory, 'http-fetch.mjs');
    writeFileSync(mock, `import { writeFileSync } from 'node:fs'; globalThis.fetch = async (url, options) => { writeFileSync(${JSON.stringify(probe)}, JSON.stringify({ url, redirect: options.redirect })); return new Response(JSON.stringify({ok:true, account:{username:'test'}, project:{id:'demo'}, permissions:['workspace.read']}), {status:200,headers:{'content-type':'application/json'}}); };`);
    const environment = { WORKBENCH_CONFIG_HOME: configHome, WORKBENCH_TOKEN: 'transport-test-token', NODE_OPTIONS: '--import ' + pathToFileURL(mock).href };
    expect((await invoke(['configure', '--url', 'http://example.com:14311'], environment)).code).toBe('HTTPS_REQUIRED');
    expect(existsSync(probe)).toBe(false);
    const configured = await invoke(['configure', '--url', 'http://example.com:14311', '--allow-insecure-http'], environment);
    expect(configured.configured).toBe(true); expect(configured.warning).toContain('unencrypted');
    const configFile = join(configHome, 'default.json'); const saved = JSON.parse(readFileSync(configFile, 'utf8'));
    expect(saved.insecureHttpOrigin).toBe('http://example.com:14311'); expect(JSON.stringify(saved)).not.toContain('transport-test-token');
    expect((await invoke(['connect'], { ...environment, WORKBENCH_TOKEN: '' })).code).toBe('CREDENTIAL_REQUIRED'); expect(existsSync(probe)).toBe(false);
    expect((await invoke(['connect', '--allow-insecure-http'], environment)).code).toBe('ARGUMENT');
    expect((await invoke(['connect'], environment)).ok).toBe(true);
    expect(JSON.parse(readFileSync(probe, 'utf8'))).toEqual({url:'http://example.com:14311/api/agent/connect',redirect:'error'});
    for (const changed of [{ ...saved, url: 'http://example.com:14312' }, { ...saved, url: 'http://other.example:14311' }, { ...saved, insecureHttpOrigin: true }]) {
        writeFileSync(configFile, JSON.stringify(changed)); expect((await invoke(['connect'], environment)).code).toBe('CONFIG_INVALID');
    }
});
it('HTTP 开关不能用于其他协议、重复选项或非配置命令', async () => {
    for (const origin of ['https://example.com', 'ftp://example.com', 'http://localhost']) {
        expect((await invoke(['configure','--profile','invalid-http','--url',origin,'--allow-insecure-http'])).code).toBe('ARGUMENT');
    }
    expect((await invoke(['configure','--url','http://example.com','--allow-insecure-http','--allow-insecure-http'])).code).toBe('ARGUMENT');
    expect((await invoke(['configure','--profile','safe-https','--url','https://example.com'])).configured).toBe(true);
    expect(JSON.parse(readFileSync(join(directory,'config/safe-https.json'),'utf8')).insecureHttpOrigin).toBeUndefined();
    expect((await invoke(['configure','--help'])).usage).toContain('--allow-insecure-http');
});
it('配置不存密钥，拒绝不安全地址、覆盖和缺失凭据',async()=>{
    expect((await invoke(['configure','--url','http://example.com'])).code).toBe('HTTPS_REQUIRED');
    expect((await invoke(['configure','--url',url])).configured).toBe(true);
    expect(readFileSync(join(directory,'config/default.json'),'utf8')).not.toContain(token);
    expect((await invoke(['configure','--url',url])).code).toBe('CONFIG_EXISTS');
    expect((await invoke(['connect'],{WORKBENCH_TOKEN:''})).code).toBe('CREDENTIAL_REQUIRED');
    const check=await invoke(['connect']);expect(check.ok).toBe(true);expect(check.account.username).toBe('designer');
    expect(Array.isArray((await invoke(['find','--query','霜刃'])).items)).toBe(true);
    expect(Array.isArray((await invoke(['versions','--json','{"action":"list"}'])).items)).toBe(true);
});
it('独立任务连续修改、同一会话撤销、释放；另一任务不可抢占',async()=>{
    const task=(await invoke(['new-task'])).taskId;
    expect(service.control.publicState(service.workspace(human).id)).toBeNull();
    const file=input('edit',{requestId:'kit-edit',operations:[{type:'field',id:'frost',key:'cost',expected:2,value:3}]});
    expect((await invoke(['edit','--input',file])).code).toBe('TASK_REQUIRED');
    const result=await invoke(['edit','--task',task,'--input',file]);expect(result.ok).toBe(true);expect(result.writeSessionId).toBeTruthy();
    const stolen = await app.inject({ method: 'POST', url: '/api/workspace/operations', headers: { authorization: 'Bearer ' + token }, payload: { requestId: 'borrowed-session', taskId: 'other-task', writeSessionId: result.writeSessionId, operations: [{ type: 'field', id: 'frost', key: 'cost', expected: 3, value: 9 }] } });
    expect(stolen.json().code).toBe('WRITE_SESSION_INVALID');
    const other=(await invoke(['new-task'])).taskId;
    expect((await invoke(['edit','--task',other,'--input',input('other',{requestId:'kit-other',operations:[{type:'field',id:'frost',key:'cost',expected:3,value:4}]})])).code).toBe('WORKSPACE_LOCKED');
    const undo=input('undo',{action:'undo',requestId:'kit-undo',id:'agent:'+result.writeSessionId});expect((await invoke(['history','--task',task,'--input',undo])).ok).toBe(true);
    expect((await invoke(['release','--task',task])).ok).toBe(true);expect(service.control.publicState(service.workspace(human).id)).toBeNull();
    expect((await invoke(['edit','--task',task,'--input',file])).code).toBe('TASK_CLOSED');
},30000);
it('人工收回后停止，换任务也不绕过；显式恢复并重读后才可写入',async()=>{
    const task=(await invoke(['new-task'])).taskId;
    const first=await invoke(['edit','--task',task,'--input',input('revoke-first',{requestId:'revoke-first',operations:[{type:'field',id:'frost',key:'cost',expected:2,value:3}]})]);expect(first.ok).toBe(true);
    service.control.action(human,service.workspace(human).id,{action:'revoke',writeSessionId:first.writeSessionId});
    const file=input('revoke-second',{requestId:'revoke-second',operations:[{type:'field',id:'frost',key:'cost',expected:3,value:4}]});
    expect((await invoke(['edit','--task',task,'--input',file])).code).toBe('WRITE_SESSION_REVOKED');
    expect((await invoke(['edit','--task',task,'--input',file])).code).toBe('WRITE_SESSION_INTERRUPTED');
    const other=(await invoke(['new-task'])).taskId;expect((await invoke(['edit','--task',other,'--input',file])).code).toBe('WRITE_SESSION_REVOKED');
    expect((await invoke(['resume','--task',task])).ok).toBe(true);expect((await invoke(['read','--json','{"ids":["frost"]}'])).ok).toBe(true);expect((await invoke(['edit','--task',task,'--input',file])).ok).toBe(true);expect((await invoke(['release','--task',task])).ok).toBe(true);
},30000);
it('本地任务互斥、身份绑定和未决请求阻止不同修改',async()=>{
    const task=(await invoke(['new-task'])).taskId, stateFile=join(directory,'config/default-tasks',task+'.json');
    writeFileSync(stateFile+'.lock','');expect((await invoke(['release','--task',task])).code).toBe('TASK_BUSY');rmSync(stateFile+'.lock');
    expect((await invoke(['release','--task',task],{WORKBENCH_TOKEN:'another-test-token'})).code).toBe('TASK_IDENTITY_CHANGED');
    const state=JSON.parse(readFileSync(stateFile,'utf8'));state.pending={intent:'uncertain'};writeFileSync(stateFile,JSON.stringify(state));
    expect((await invoke(['edit','--task',task,'--input',input('uncertain',{requestId:'different',operations:[]})])).code).toBe('REQUEST_UNCERTAIN');expect(existsSync(stateFile+'.lock')).toBe(false);
});
