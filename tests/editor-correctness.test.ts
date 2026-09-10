// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({apply:vi.fn()}));
vi.mock('../src/web/state',()=>({useSnapshot:()=>null,getSnapshot:()=>null,apply:mocks.apply,put:vi.fn(),notify:vi.fn(),navigate:vi.fn()}));
vi.mock('../src/web/editing',()=>({locked:()=>false,registerBuffer:()=>()=>{},editingChanged:()=>{},afterEditing:vi.fn(),flushEditing:vi.fn()}));
vi.mock('../src/web/CommandSurface',()=>({EntityMenuButton:()=>null}));
import { Cell } from '../src/web/CollectionView';
import { DirectoryTree } from '../src/web/DirectoryTree';
import type { DesignObject } from '../src/shared/model';
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve() } });
let container:HTMLDivElement,root:ReturnType<typeof createRoot>;
function mount(element:ReturnType<typeof createElement>){container=document.createElement('div');document.body.append(container);root=createRoot(container);act(()=>root.render(element));}
afterEach(()=>{if(root)act(()=>root.unmount());container?.remove();mocks.apply.mockReset();});
const row:DesignObject={id:'record',kind:'object',path:'constructor/page.md',title:'记录',collection:null,body:'',fields:{description:'original'}};
it('合法的原型同名目录能够渲染',()=>{
 expect(()=>mount(createElement(DirectoryTree,{entities:[row,{...row,id:'other',path:'__proto__/toString/page.md'}],selected:row.id}))).not.toThrow();
 expect(container.textContent).toContain('constructor');
});
it('保存中新增输入必须继续提交，不被旧响应覆盖',async()=>{
 let release!:()=>void;
 mocks.apply.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;})).mockResolvedValue(undefined);
 mount(createElement(Cell,{row,field:{key:'description',label:'说明',type:'text',required:false}}));
 const input=container.querySelector('textarea')!;
 const type=(value:string)=>act(()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});
 type('first');act(()=>input.dispatchEvent(new FocusEvent('focusout',{bubbles:true})));
 expect(mocks.apply).toHaveBeenCalledTimes(1);
 type('second');await act(async()=>{release();});
 expect(input.value).toBe('second');
 expect(mocks.apply).toHaveBeenCalledTimes(2);
 expect(mocks.apply.mock.calls[1][0][0]).toMatchObject({expected:'first',value:'second'});
});
