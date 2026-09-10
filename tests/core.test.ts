import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { Transform } from '@milkdown/prose/transform';
import { Store } from '../src/server/store.js';
import { createCodec, type Codec } from '../src/server/codec.js';
import { Service } from '../src/server/service.js';
import { seed } from '../src/server/seed.js';
import { actorFor, issueToken, capabilities, Fault } from '../src/server/auth.js';
import { deletionTargets } from '../src/shared/deletion.js';
import { serialize, deserialize, diagnostics, mergeTrees, type Actor, type DesignObject } from '../src/shared/model.js';
let codec:Codec,store:Store,service:Service,directory:string,designer:Actor,developer:Actor;
beforeAll(async()=>{codec=await createCodec();});


it('旧数据中的交错历史拒绝误撤销，不覆盖当前草稿',()=>{
 field(designer,'cost',2,3,'legacy-a');
 service.mutate(designer,randomUUID(),[{type:'patch',id:'guide',before:'返回',after:'请返回'}],'legacy-b');
 field(designer,'cost',3,4,'legacy-a');
 const workspace=service.workspace(designer),segment=service.history(designer)[0].id;
 store.db.prepare('UPDATE operations SET group_id=? WHERE workspace_id=? AND group_id=?').run('legacy-a',workspace.id,segment);
 store.db.prepare('DELETE FROM history_entries WHERE workspace_id=? AND group_id=?').run(workspace.id,segment);
 store.db.prepare('UPDATE history_entries SET after_tree=? WHERE workspace_id=? AND group_id=?').run(workspace.head,workspace.id,'legacy-a');
 expect(()=>service.historyStep(designer,{requestId:randomUUID(),direction:'undo',groupId:'legacy-a'})).toThrow('旧历史包含交错编辑');
 expect(service.workspace(designer).head).toBe(workspace.head);
});


it('交错变更组撤销不会夹带其他组的字段修改', () => {
 field(designer,'cost',2,3,'group-a');
 service.mutate(designer,randomUUID(),[{type:'patch',id:'guide',before:'返回',after:'请返回'}],'group-b');
 field(designer,'cost',3,4,'group-a');
 service.historyStep(designer,{requestId:randomUUID(),direction:'undo'});
 expect((service.snapshot(designer).tree.guide as DesignObject).body).toContain('请返回');
 expect(service.history(designer).find(entry=>entry.id==='group-b')?.state).toBe('applied');
 expect((service.snapshot(designer).tree.frost as DesignObject).fields.cost).toBe(3);
 service.historyStep(designer,{requestId:randomUUID(),direction:'undo',groupId:'group-a'});
 expect((service.snapshot(designer).tree.frost as DesignObject).fields.cost).toBe(2);
 expect((service.snapshot(designer).tree.guide as DesignObject).body).toContain('请返回');
 service.historyStep(designer,{requestId:randomUUID(),direction:'redo',groupId:'group-a'});
 expect((service.snapshot(designer).tree.frost as DesignObject).fields.cost).toBe(3);
});
it('Markdown 代码示例不参与发布校验', () => {
 const tree=service.snapshot(designer).tree;
 const guide=tree.guide as DesignObject;
 guide.body='~~~md\n:::view[missing-view]\n[示例](doc:missing-doc)\n~~~\n\n行内 `[示例](doc:missing-inline)`';
 expect(diagnostics(tree,true)).toEqual([]);
});
afterAll(async()=>{await codec.close();});
beforeEach(()=>{directory=mkdtempSync(join(tmpdir(),'design-workbench-test-'));store=new Store(directory);seed(store,'test-password-123');service=new Service(store,codec);const users=store.db.prepare('SELECT * FROM users').all() as any[];const actor=(username:string):Actor=>({userId:users.find(user=>user.username===username).id,username,projectId:'demo',kind:'human',sessionId:username,scopes:capabilities,canSync:username==='developer'});designer=actor('designer');developer=actor('developer');});
afterEach(()=>{store.close();if(directory.startsWith(join(tmpdir(),'design-workbench-test-')))rmSync(directory,{recursive:true,force:true});});
const field=(actor:Actor,key:string,expected:unknown,value:unknown,groupId?:string)=>service.mutate(actor,randomUUID(),[{type:'field',id:'frost',key,expected,value}],groupId);
const publish=()=>{const preview=service.preview(designer);return service.publish(designer,{requestId:randomUUID(),head:preview.head,main:preview.main,title:'修改技能消耗',description:'独立验证'}) as any;};
it('嵌入块 Markdown 往返，代码块和行内示例不转换', () => {
 const doc=codec.parse(':::view[skills-table]\n\n:::doc[guide]');
 expect(doc.child(0).type.name).toBe('workbench_embed'); expect(doc.child(1).attrs.target).toBe('guide');
 expect(codec.serialize(doc)).toContain(':::view[skills-table]');
 expect(codec.parse(codec.serialize(doc)).eq(doc)).toBe(true);
 expect(codec.parse('示例 :::view[skills-table]').firstChild!.type.name).toBe('paragraph');
 expect(codec.parse('```\n:::view[skills-table]\n```').firstChild!.type.name).toBe('code_block');
});

describe('发布前丢弃草稿修改', () => {
 it('无影响撤回恢复正式基线、内容和发布文案，不留发布记录，可再次发布', () => {
  field(designer,'cost',2,7); const publication=publish();
  expect(service.changes(designer)[0].withdrawalBlocker).toBeNull();
  service.withdraw(designer,{id:publication.id,revision:publication.revision});
  expect(store.main('demo')).toBe(publication.old_main);
  expect(service.workspace(designer).base).toBe(publication.old_main);
  expect(service.workspace(designer).head).toBe(publication.tree);
  expect(service.changes(designer)).toEqual([]);
  expect(store.db.prepare('SELECT 1 FROM revisions WHERE id=?').get(publication.revision)).toBeUndefined();
  service=new Service(store,codec);
  expect(service.preview(designer).publicationDraft).toEqual({title:publication.title,description:publication.description});
  expect(service.preview(designer).diff.length).toBeGreaterThan(0);
  publish(); expect(service.preview(designer).publicationDraft).toBeUndefined();
 });
 it('非本人、缺权限和过期版本不能撤回', () => {
  field(designer,'cost',2,7); const publication=publish(), input={id:publication.id,revision:publication.revision};
  expect(()=>service.withdraw(developer,input)).toThrow('仅发布者');
  expect(()=>service.withdraw({...designer,scopes:['workspace.read']},input)).toThrow('缺少权限');
  expect(()=>service.withdraw(designer,{...input,revision:publication.old_main})).toThrow('已更新');
  expect(store.main('demo')).toBe(publication.revision);
 });
 it('其他工作区吸收正式版后，即使没有修改也阻止撤回', () => {
  service.workspace(developer); field(designer,'cost',2,7); const publication=publish();
  const preview=service.preview(developer);
  service.refresh(developer,{requestId:randomUUID(),head:preview.head,main:preview.main});
  expect(()=>service.withdraw(designer,{id:publication.id,revision:publication.revision})).toThrow('已有工作区');
 });
 it('发布后新建的工作区也阻止撤回', () => {
  field(designer,'cost',2,7); const publication=publish(); service.workspace({...developer,userId:randomUUID()});
  expect(()=>service.withdraw(designer,{id:publication.id,revision:publication.revision})).toThrow('已有工作区');
 });
 it('新草稿和后续发布阻止撤回', () => {
  field(designer,'cost',2,7); const publication=publish(), input={id:publication.id,revision:publication.revision};
  field(designer,'cost',7,8); expect(()=>service.withdraw(designer,input)).toThrow('已有草稿修改');
  publish(); expect(()=>service.withdraw(designer,input)).toThrow('最新正式发布');
 });
 it('确认同步后再取消仍不能撤回', () => {
  service.workspace(developer); field(designer,'cost',2,7); const publication=publish();
  const input={ids:[publication.id],repository:'test',commit:'abc',note:'verified'};
  service.confirm(developer,{...input,requestId:randomUUID(),active:true});
  expect(()=>service.withdraw(designer,{id:publication.id,revision:publication.revision})).toThrow('实现同步记录');
  service.confirm(developer,{...input,requestId:randomUUID(),active:false});
  expect(()=>service.withdraw(designer,{id:publication.id,revision:publication.revision})).toThrow('实现同步记录');
 });
 it.each([false,true])('撤回中断恢复，不留临时状态：Git 已回退 %s', reverted => {
  field(designer,'cost',2,7); const publication=publish();
  store.db.prepare("UPDATE publications SET state='withdrawing' WHERE id=?").run(publication.id);
  if(reverted) store.git('demo',['update-ref','refs/heads/main',publication.old_main,publication.revision]);
  service=new Service(store,codec); service.recover();
  expect(store.main('demo')).toBe(publication.old_main);
  expect(service.workspace(designer).head).toBe(publication.tree);
  expect(service.preview(designer).publicationDraft).toEqual({title:publication.title,description:publication.description});
  expect(store.db.prepare('SELECT 1 FROM publications WHERE id=?').get(publication.id)).toBeUndefined();
 });
 const inputFor = (targets: {id:string;key?:string}[]) => { const preview = service.preview(designer); return { requestId:randomUUID(), head:preview.head, base:preview.base, main:preview.main, targets }; };
 it('丢弃字段保留其他有效修改，幂等且可以撤销重做', () => {
  field(designer,'cost',2,9); service.mutate(designer,randomUUID(),[{type:'patch',id:'overview',before:'3 点能量',after:'4 点能量'}]);
  const item=service.preview(designer).review.find(item=>item.id==='frost'&&item.property==='cost')!;
  const input=inputFor([{id:item.id,key:item.key}]); const result=service.discard(designer,input);
  expect((service.snapshot(designer).tree.frost as DesignObject).fields.cost).toBe(2); expect((service.snapshot(designer).tree.overview as DesignObject).body).toContain('4 点能量');
  expect(service.discard(designer,input)).toEqual(result);
  service.undo(designer,randomUUID(),result.groupId); expect((service.snapshot(designer).tree.frost as DesignObject).fields.cost).toBe(9);
  service.historyStep(designer,{requestId:randomUUID(),direction:'redo',groupId:result.groupId}); expect((service.snapshot(designer).tree.frost as DesignObject).fields.cost).toBe(2);
 });
 it('预览失效和缺少权限时拒绝，不改变草稿',()=>{
  field(designer,'cost',2,8); const input=inputFor([{id:'frost'}]); field(designer,'cost',8,9); const head=service.workspace(designer).head;
  expect(()=>service.discard(designer,input)).toThrow('已更新'); expect(service.workspace(designer).head).toBe(head);
  expect(()=>service.discard({...designer,scopes:['workspace.read']},inputFor([{id:'frost'}]))).toThrow('缺少权限');
 });
 it('丢弃新增集合前先列出关联记录与视图，未明确同意则拒绝',()=>{
  const entities:any[]=[{id:'discard-set',kind:'collection',title:'新增集合',path:'discard/set.json',fields:[]},{id:'discard-row',kind:'object',title:'新增记录',path:'discard/row.md',collection:'discard-set',fields:{},body:''},{id:'discard-view',kind:'view',title:'新增视图',path:'discard/view.json',collection:'discard-set',columns:['title'],layout:'table',filter:null,sort:null}];
  service.mutate(designer,randomUUID(),entities.map(entity=>({type:'put' as const,entity,expected:null})));
  const input=inputFor([{id:'discard-set'}]); const plan=service.discardPreview(designer,input); expect(plan.dependencies.map(item=>item.id).sort()).toEqual(['discard-row','discard-view']); expect(plan.issues).toEqual([]);
  expect(()=>service.discard(designer,input)).toThrow('明确确认'); const result=service.discard(designer,{...input,targets:plan.targets}); expect(service.snapshot(designer).tree['discard-set']).toBeUndefined();
  service.undo(designer,randomUUID(),result.groupId); expect(service.snapshot(designer).tree['discard-row']).toBeDefined();
 });
 it('丢弃自己的修改恢复基线，发布时仍保留团队的新修改',()=>{
  field(designer,'cost',2,9); field(developer,'cost',2,4); const preview=service.preview(developer); service.publish(developer,{requestId:randomUUID(),head:preview.head,main:preview.main,title:'团队更新',description:''});
  service.discard(designer,inputFor([{id:'frost'}])); expect((service.snapshot(designer).tree.frost as DesignObject).fields.cost).toBe(2); expect((service.preview(designer).candidate.frost as DesignObject).fields.cost).toBe(4);
 });
 it('重复正文目标只恢复一次，结构不合法的丢弃原子失败',()=>{
  const initial=service.snapshot(designer).tree.overview;
  service.mutate(designer,randomUUID(),[{type:'patch',id:'overview',before:'3 点能量',after:'12345 点能量'}]);
  const changed=service.snapshot(designer).tree.overview as DesignObject;
  const item=service.preview(designer).review.find(item=>item.id==='overview'&&item.kind==='正文'&&String(item.after).includes('12345'))!;
  service.discard(designer,inputFor([{id:item.id,key:item.key},{key:item.key,id:item.id}]));
  expect(service.snapshot(designer).tree.overview).toEqual({...initial,body:changed.body.replace('12345 点能量','3 点能量')});
  const tree=service.snapshot(designer).tree, collection=tree.skills;
  if(collection.kind!=='collection')throw Error('collection');
  const updated={...collection,fields:[...collection.fields,{key:'new_value',label:'新增字段',type:'number' as const,required:false}]};
  service.mutate(designer,randomUUID(),[{type:'put',entity:updated,expected:collection},{type:'field',id:'frost',key:'new_value',expected:null,value:5}]);
  const input=inputFor([{id:'skills'}]), head=service.workspace(designer).head;
  expect(service.discardPreview(designer,input).issues.length).toBeGreaterThan(0);
  expect(()=>service.discard(designer,input)).toThrow('破坏内容结构');
  expect(service.workspace(designer).head).toBe(head);
 });
 it('整文件丢弃正文后读取缓存不会重新产生差异',()=>{
  const original=service.snapshot(designer).tree.overview; service.document(designer,'overview');
  service.mutate(designer,randomUUID(),[{type:'patch',id:'overview',before:'3 点能量',after:'9 点能量'}]);
  service.discard(designer,inputFor([{id:'overview'}])); service.document(designer,'overview');
  expect(service.snapshot(designer).tree.overview).toEqual(original); expect(service.preview(designer).review).toHaveLength(0);
 });
});
it('旧协作缓存增量升级且不改变草稿或创建历史', () => {
 const snapshot=service.snapshot(designer); const current=service.document(designer,'overview');
 const legacy=JSON.stringify(current.doc).replace(/\{\"type\":\"workbench_embed\",\"attrs\":\{\"kind\":\"view\",\"target\":\"skills-table\"\}\}/,JSON.stringify({type:'paragraph',content:[{type:'text',text:':::view[skills-table]'}]}));
 expect(legacy).not.toBe(JSON.stringify(current.doc));
 store.db.prepare('UPDATE documents SET doc=? WHERE workspace_id=? AND entity_id=?').run(legacy,snapshot.workspace.id,'overview');
 const next=service.document(designer,'overview',current.version); expect(next.version).toBeGreaterThan(current.version); expect(next.schemaVersion).toBe(4);
 expect(service.snapshot(designer).workspace.head).toBe(snapshot.workspace.head);
 expect(service.document(designer,'overview').version).toBe(next.version);
});
it('筛选与分页配置原子保存，并能整体撤销重做', () => {
 const view=service.snapshot(designer).tree['skills-table']; if(view.kind!=='view')throw Error('view');
 service.mutate(designer,randomUUID(),[{type:'put',expected:view,entity:{...view,filters:[{key:'cost',operator:'gte',value:2}],pagination:{pageSize:10}}}],'query-config');
 expect(service.snapshot(designer).tree['skills-table']).toMatchObject({pagination:{pageSize:10}});
 service.undo(designer,randomUUID(),'query-config'); expect(service.snapshot(designer).tree['skills-table']).toEqual(view);
});
describe('文本内容与真实存储',()=>{
 it('Markdown/YAML 往返和内容树重读保持字段',()=>{const entity=service.snapshot(designer).tree.frost;expect(deserialize(serialize(entity))).toEqual(entity);expect(store.tree(store.putTree({frost:entity}))).toEqual({frost:entity});});
 it('Milkdown 支持语法规范化后稳定往返',()=>{const text='# 标题\n\n**重点** 与 [链接](doc:overview)。\n\n:::view[skills-table]\n\n- 一\n- 二\n\n| 名称 | 值 |\n| --- | --- |\n| 甲 | 2 |\n';const doc=codec.parse(text),canonical=codec.serialize(doc);expect(codec.serialize(codec.parse(canonical))).toBe(canonical);expect(codec.parse(canonical).toJSON()).toEqual(doc.toJSON());});
 it('拒绝路径穿越且不发生部分写入',()=>{const before=service.snapshot(designer);const entity={...before.tree.frost,path:'../outside.md'};expect(()=>service.mutate(designer,randomUUID(),[{type:'field',id:'frost',key:'cost',expected:2,value:3},{type:'put',entity,expected:before.tree.frost}])).toThrow();expect(service.snapshot(designer).workspace.head).toBe(before.workspace.head);});
 it('拒绝重复路径及非法字段类型',()=>{expect(()=>field(designer,'cost',2,'three')).toThrow();const tree=service.snapshot(designer).tree;tree.frost.path=tree.guard.path;expect(diagnostics(tree)).not.toEqual([]);});
 it('确认保存后重新打开数据库仍保留',()=>{field(designer,'cost',2,4);store.close();store=new Store(directory);service=new Service(store,codec);expect((service.snapshot(designer).tree.frost as DesignObject).fields.cost).toBe(4);});
});
describe('结构化集合删除与操作组撤销', () => {
 it('集合、视图及字段结构的新增修改可以撤销', () => {
  const before = service.snapshot(designer).tree;
  const collection = {id:'custom',kind:'collection' as const,title:'自定义',path:'集合/custom.json',fields:[]};
  service.mutate(designer,randomUUID(),[{type:'put',entity:collection,expected:null}],'create-collection');
  service.undo(designer,randomUUID(),'create-collection');
  expect(service.snapshot(designer).tree).toEqual(before);
  const view=before['skills-table'];
  if(view.kind!=='view') throw Error('view');
  service.mutate(designer,randomUUID(),[{type:'put',entity:{...view,layout:'cards'},expected:view}],'view-layout');
  service.undo(designer,randomUUID(),'view-layout');
  expect(service.snapshot(designer).tree).toEqual(before);
  const schema=before.skills;
  if(schema.kind!=='collection') throw Error('collection');
  service.mutate(designer,randomUUID(),[{type:'put',entity:{...schema,fields:[...schema.fields,{key:'extra',label:'额外',type:'text',required:false}]},expected:schema}],'schema');
  service.undo(designer,randomUUID(),'schema');
  expect(service.snapshot(designer).tree).toEqual(before);
 });
 it('引用阻止删除，解除后可整体删除并完整撤销', () => {
  let tree=service.snapshot(designer).tree;
  const targets=deletionTargets(tree,tree.skills);
  expect(()=>service.mutate(designer,randomUUID(),targets.map(entity=>({type:'delete' as const,id:entity.id,expected:entity})))).toThrow('引用');
  expect(service.snapshot(designer).tree).toEqual(tree);
  service.mutate(designer,randomUUID(),['overview','guide'].map(id=>({type:'put' as const,entity:{...tree[id],body:''},expected:tree[id]})));
  tree=service.snapshot(designer).tree;
  service.mutate(designer,randomUUID(),deletionTargets(tree,tree.skills).map(entity=>({type:'delete' as const,id:entity.id,expected:entity})),'delete-collection');
  expect(service.snapshot(designer).tree.skills).toBeUndefined();
  expect(service.preview(designer).diagnostics).toEqual([]);
  service.undo(designer,randomUUID(),'delete-collection');
  expect(service.snapshot(designer).tree).toEqual(tree);
 });
 it('确认后新增的引用阻止删除，并发新增记录不会成为孤儿', () => {
  const tree=service.snapshot(designer).tree;
  const frost=tree.frost;
  const overview=tree.overview;
  if(overview.kind!=='object') throw Error('object');
  service.mutate(designer,randomUUID(),[{type:'put',entity:{...overview,body:overview.body+'\n\n[霜刃](doc:frost)'},expected:overview}]);
  expect(()=>service.mutate(designer,randomUUID(),[{type:'delete',id:frost.id,expected:frost}])).toThrow('引用');
  expect(service.snapshot(designer).tree.frost).toEqual(frost);
 });
});
describe('并发、隔离、幂等与撤销',()=>{
 it('不同账号草稿隔离，灵感共享',()=>{field(designer,'cost',2,3);expect((service.snapshot(developer).tree.frost as DesignObject).fields.cost).toBe(2);expect(service.notes(designer)).toEqual(service.notes(developer));});
 it('不同字段更新并存，同字段旧值拒绝覆盖',()=>{field(designer,'cost',2,3);field(designer,'description','造成伤害并施加寒冷','新说明');expect(()=>field(designer,'cost',2,4)).toThrow('字段已被修改');});
 it('重复请求只写入一次',()=>{const requestId=randomUUID(),operations:any=[{type:'field',id:'frost',key:'cost',expected:2,value:3}];expect(service.mutate(designer,requestId,operations)).toEqual(service.mutate(designer,requestId,operations));expect(service.history(designer)).toHaveLength(1);});
 it('撤销 Agent 变更保留人工对其他字段的后续编辑',()=>{const agent={...designer,kind:'agent' as const};field(agent,'cost',2,3,'agent-task');field(designer,'description','造成伤害并施加寒冷','人工说明');service.undo(designer,randomUUID(),'agent-task');const entity=service.snapshot(designer).tree.frost as DesignObject;expect(entity.fields).toEqual({cost:2,description:'人工说明'});});
 it('同字段后续修改阻止危险撤销',()=>{field(designer,'cost',2,3,'agent-task');field(designer,'cost',3,4);expect(()=>service.undo(designer,randomUUID(),'agent-task')).toThrow('后续修改');});
 it('Agent token 限定用户工作区及独立灵感权限，可撤销',()=>{const issued=issueToken(store,designer,'test',['workspace.read']);const agent=actorFor(store,issued.token,true);expect(service.snapshot(agent).workspace.user_id).toBe(designer.userId);expect(()=>service.notes(agent)).toThrow('缺少权限');expect(()=>field(agent,'cost',2,3)).toThrow();store.db.prepare('DELETE FROM tokens WHERE id=?').run(issued.id);expect(()=>actorFor(store,issued.token,true)).toThrow();});
 it('持久化文档增量操作并拒绝旧文本版本',()=>{const initial=service.document(designer,'overview');const doc=codec.schema.nodeFromJSON(initial.doc),transform=new Transform(doc).insert(1,codec.schema.text('人工 '));const input={requestId:randomUUID(),version:initial.version,steps:transform.steps.map(step=>step.toJSON()),clientId:'client',groupId:'typing'};const result=service.textSteps(designer,'overview',input);expect(result.document.body).toContain('人工');expect(service.textSteps(designer,'overview',input)).toEqual(result);expect(()=>service.textSteps(designer,'overview',{...input,requestId:randomUUID()})).toThrow('文档有新操作');});
 it('Agent 段落补丁进入相同文档步骤流',()=>{service.document(designer,'overview');service.mutate({...designer,kind:'agent'},randomUUID(),[{type:'patch',id:'overview',before:'3 点能量',after:'4 点能量'}]);const remote=service.document(designer,'overview',0);expect(remote.body).toContain('4 点能量');expect(remote.steps.length).toBeGreaterThan(0);});
});
describe('发布和同步',()=>{
 it('合并预览返回双方和基线，自定义字段解决不发布且可幂等重试',()=>{
  field(designer,'cost',2,3); publish(); field(developer,'cost',2,4);
  const preview=service.preview(developer);
  expect(preview.conflictDetails).toContainEqual(expect.objectContaining({path:'/frost/fields/cost',base:2,ours:4,theirs:3}));
  expect(preview.incoming.length).toBeGreaterThan(0);
  const input={requestId:randomUUID(),head:preview.head,main:preview.main,resolutions:{'/frost/fields/cost':{value:5}}};
  const result=service.refresh(developer,input);
  expect(service.refresh(developer,input)).toEqual(result);
  expect((service.snapshot(developer).tree.frost as DesignObject).fields.cost).toBe(5);
  expect(service.workspace(developer).base).toBe(preview.main);
  expect(store.main('demo')).toBe(preview.main);
  expect(service.changes(developer)).toHaveLength(1);
 });
 it('自定义冲突结果仍校验字段类型并原子回滚',()=>{
  field(designer,'cost',2,3); publish(); field(developer,'cost',2,4);
  const preview=service.preview(developer), before=service.snapshot(developer);
  expect(()=>service.refresh(developer,{requestId:randomUUID(),head:preview.head,main:preview.main,resolutions:{'/frost/fields/cost':{value:'not a number'}}})).toThrow('校验失败');
  expect(service.snapshot(developer).workspace).toEqual(before.workspace);
  expect(service.snapshot(developer).tree).toEqual(before.tree);
 });
 it('拒绝非冲突路径和过期合并结果',()=>{
  field(designer,'cost',2,3); publish(); field(developer,'cost',2,4);
  const preview=service.preview(developer);
  expect(()=>service.refresh(developer,{requestId:randomUUID(),head:preview.head,main:preview.main,resolutions:{'/frost/title':{value:'unexpected'}}})).toThrow('未知冲突');
  field(developer,'cost',4,6);
  expect(()=>service.refresh(developer,{requestId:randomUUID(),head:preview.head,main:preview.main,resolutions:{'/frost/fields/cost':{value:5}}})).toThrow('重新预览');
  const next=service.preview(developer); field(designer,'cost',3,7); publish();
  expect(()=>service.refresh(developer,{requestId:randomUUID(),head:next.head,main:next.main,resolutions:{'/frost/fields/cost':{value:5}}})).toThrow('重新预览');
 });
 it('删除与修改冲突拒绝非法自定义对象，显式选删除会清理文档状态',()=>{
  const entity=service.snapshot(designer).tree.guide;
  service.mutate(designer,randomUUID(),[{type:'put',entity:{...entity,id:'merge-delete',path:'设计/merge-delete.md'},expected:null}]); publish();
  let preview=service.preview(developer); service.refresh(developer,{requestId:randomUUID(),head:preview.head,main:preview.main});
  service.document(developer,'merge-delete');
  const current=service.snapshot(developer).tree['merge-delete'];
  service.mutate(developer,randomUUID(),[{type:'put',entity:{...current,title:'我的修改'},expected:current}]);
  service.mutate(designer,randomUUID(),[{type:'delete',id:'merge-delete',expected:service.snapshot(designer).tree['merge-delete']}]); publish();
  preview=service.preview(developer);
  expect(preview.conflicts).toContain('/merge-delete');
  for(const value of [null,5,JSON.parse(JSON.stringify({...current,id:'wrong-id'}))]) expect(()=>service.refresh(developer,{requestId:randomUUID(),head:preview.head,main:preview.main,resolutions:{'/merge-delete':{value}}})).toThrow('数据结构不合法');
  service.refresh(developer,{requestId:randomUUID(),head:preview.head,main:preview.main,resolutions:{'/merge-delete':'theirs'}});
  expect(service.snapshot(developer).tree['merge-delete']).toBeUndefined();
  expect(store.db.prepare('SELECT 1 FROM documents WHERE workspace_id=? AND entity_id=?').get(service.workspace(developer).id,'merge-delete')).toBeUndefined();
 });
 it('发布生成真实 Git revision，没有审批状态',()=>{field(designer,'cost',2,3);const change=publish();expect(store.main('demo')).toBe(change.revision);expect(store.git('demo',['show',change.revision+':技能/frost.md'])).toContain('cost: 3');expect(service.changes(designer)[0].confirmations).toEqual([]);expect(service.preview(designer).diff).toHaveLength(0);});
 it('预览后编辑会令发布前提失效',()=>{field(designer,'cost',2,3);const preview=service.preview(designer);field(designer,'cost',3,4);expect(()=>service.publish(designer,{requestId:randomUUID(),head:preview.head,main:preview.main,title:'过期',description:''})).toThrow('预览已过期');});
 it('main 前进后采用三方合并保留双方字段',()=>{field(designer,'cost',2,3);publish();field(developer,'description','造成伤害并施加寒冷','程序员说明');const preview=service.preview(developer);expect(preview.conflicts).toEqual([]);service.refresh(developer,{requestId:randomUUID(),head:preview.head,main:preview.main});expect((service.snapshot(developer).tree.frost as DesignObject).fields).toEqual({cost:3,description:'程序员说明'});});
 it('同字段冲突必须显式解决',()=>{field(designer,'cost',2,3);publish();field(developer,'cost',2,4);const preview=service.preview(developer);expect(preview.conflicts).toContain('/frost/fields/cost');expect(()=>service.refresh(developer,{requestId:randomUUID(),head:preview.head,main:preview.main})).toThrow('需要解决');service.refresh(developer,{requestId:randomUUID(),head:preview.head,main:preview.main,resolutions:{'/frost/fields/cost':'ours'}});expect((service.snapshot(developer).tree.frost as DesignObject).fields.cost).toBe(4);});
 it('程序员记录外部确认，不要求平台访问仓库',()=>{field(designer,'cost',2,3);const change=publish();const input={requestId:randomUUID(),ids:[change.id],repository:'demo://external-unverified',commit:'demonstration-only',note:'演示：已有实现符合，无需改动。不是实际验证。',active:true};expect(()=>service.confirm(designer,input)).toThrow('缺少权限');service.confirm(developer,input);expect(service.changes(designer)[0].confirmations[0].active).toBe(1);service.confirm(developer,{...input,requestId:randomUUID(),active:false});expect(service.changes(designer)[0].confirmations.every((item:any)=>!item.active)).toBe(true);});
 it('Git 更新后中断能从准备记录恢复',()=>{field(designer,'cost',2,3);const original=service.finishPublication;service.finishPublication=()=>{throw new Error('模拟进程中断');};expect(publish).toThrow('模拟进程中断');service.finishPublication=original;service=new Service(store,codec);expect(service.changes(designer)).toHaveLength(1);expect(service.preview(designer).diff).toEqual([]);});
});
describe('补充回归：目录、编辑器元数据与正文合并',()=>{
 it('目录创建、移动与删除是整树条件事务',()=>{
  service.mutate(designer,randomUUID(),[{type:'put',entity:{id:'folder-a',kind:'folder',title:'新目录',path:'新目录/__directory.json'},expected:null}]);
  let snapshot=service.snapshot(designer);service.mutate(designer,randomUUID(),[{type:'directory',from:'设计',to:'文档/设计',head:snapshot.workspace.head}]);
  snapshot=service.snapshot(designer);expect(snapshot.tree.overview.path).toBe('文档/设计/战斗概览.md');expect(service.preview(designer).diagnostics).toEqual([]);
  service.mutate(designer,randomUUID(),[{type:'directory',from:'新目录',to:null,head:snapshot.workspace.head}]);expect(service.snapshot(designer).tree['folder-a']).toBeUndefined();
 });
 it('正文非重叠行可以自动三方合并',()=>{
  const entity=service.snapshot(designer).tree.overview as DesignObject;const base={overview:{...entity,body:'第一行\n保持\n第三行'}};
  const merged=mergeTrees(base,{overview:{...entity,body:'修改第一行\n保持\n第三行'}},{overview:{...entity,body:'第一行\n保持\n修改第三行'}});
  expect(merged.conflicts).toEqual([]);expect((merged.tree.overview as DesignObject).body).toBe('修改第一行\n保持\n修改第三行');
 });
 it('读取文档不会重置 heading ID 造成保存循环',()=>{
  const initial=service.document(designer,'overview'),doc=codec.schema.nodeFromJSON(initial.doc),transform=new Transform(doc).setNodeMarkup(0,undefined,{level:1,id:'stable-heading'});
  service.textSteps(designer,'overview',{requestId:randomUUID(),version:initial.version,steps:transform.steps.map(step=>step.toJSON()),clientId:'client',groupId:'heading'});
  const after=service.document(designer,'overview');expect(service.document(designer,'overview').version).toBe(after.version);expect(after.doc.content[0].attrs.id).toBe('stable-heading');
 });
 it('危险对象标识与文件目录冲突被拒绝',()=>{
  const entity=service.snapshot(designer).tree.frost;
  expect(()=>service.mutate(designer,randomUUID(),[{type:'put',entity:{...entity,id:'__proto__'},expected:null}])).toThrow();
  const tree=service.snapshot(designer).tree;tree.guard.path=tree.frost.path+'/nested.md';expect(diagnostics(tree).some(issue=>issue.includes('文件与目录'))).toBe(true);
 });
});
describe('真实进程中断',()=>{
 it('收到持久化确认后强制终止子进程，重开仍保留内容',async()=>{
  store.close();
  await new Promise<void>((resolvePromise,reject)=>{const child=spawn(process.execPath,['--import','tsx',resolve('tests/crash-worker.ts')],{cwd:process.cwd(),env:{...process.env,CRASH_DATA:directory,CRASH_ACTOR:JSON.stringify(designer)},stdio:['ignore','pipe','pipe']});let confirmed=false,errors='';const timeout=setTimeout(()=>{child.kill();reject(new Error('子进程超时 '+errors));},20000);child.stderr.on('data',chunk=>{errors+=chunk;});child.stdout.on('data',chunk=>{if(chunk.toString().includes('PERSISTED')){confirmed=true;child.kill('SIGKILL');}});child.on('exit',()=>{clearTimeout(timeout);if(confirmed)resolvePromise();else reject(new Error(errors));});child.on('error',reject);});
  store=new Store(directory);service=new Service(store,codec);expect((service.snapshot(designer).tree.frost as DesignObject).fields.cost).toBe(9);
 });
});
describe('共享灵感池边界',()=>{
 it('便签独立搜索且不进入 Git 和普通搜索',()=>{expect(service.search(designer,'琥珀纸鹤')).toEqual([]);expect(service.notes(designer,'琥珀纸鹤')).toHaveLength(1);expect(store.git('demo',['ls-tree','-r','--name-only','main'])).not.toContain('idea');});
 it('共享便签并发版本检查，不触碰工作区',()=>{const before=service.snapshot(designer).workspace.head;const note=service.notes(designer)[0];const input={requestId:randomUUID(),id:note.id,version:note.version,title:note.title,body:'新想法',tags:[]};service.note(developer,input);expect(()=>service.note(designer,{...input,requestId:randomUUID()})).toThrow('便签已修改');expect(service.snapshot(designer).workspace.head).toBe(before);});
 it('复制到草稿后保持独立，原便签保留',()=>{const note=service.notes(designer)[0];const result=service.promote(designer,{requestId:randomUUID(),id:note.id,version:note.version});service.note(developer,{requestId:randomUUID(),id:note.id,version:note.version,title:note.title,body:'便签后来变化',tags:[]});expect((service.snapshot(designer).tree[result.entityId] as DesignObject).body).not.toContain('便签后来变化');expect(service.notes(designer)).toHaveLength(2);});
});
