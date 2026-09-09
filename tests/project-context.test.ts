// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();localStorage.clear();sessionStorage.clear();});
it('其他标签页的项目选择不改变本页面请求目标',async()=>{
 localStorage.setItem('workbench-project','project-a');
 const {api}=await import('../src/web/state');
 const fetcher=vi.fn<typeof fetch>(async()=>({ok:true,json:async()=>({})}) as Response);vi.stubGlobal('fetch',fetcher);
 localStorage.setItem('workbench-project','project-b');
 await api('/workspace/operations',{});
 expect((fetcher.mock.calls[0][1]?.headers as Record<string,string>)['x-project-id']).toBe('project-a');
});



it('显式切换项目使旧快照响应失效，后续请求使用新项目',async()=>{
 localStorage.setItem('workbench-project','project-a');
 const state=await import('../src/web/state');
 let release!:(value:Response)=>void;
 const fetcher=vi.fn<typeof fetch>().mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;})).mockResolvedValue({ok:true,json:async()=>({project:{id:'project-b'},tree:{},seq:0})} as Response);
 vi.stubGlobal('fetch',fetcher);
 const loading=state.reload();state.selectProject('project-b');
 release({ok:true,json:async()=>({project:{id:'project-a'},tree:{},seq:0})} as Response);
 await loading;expect(state.getSnapshot()).toBeNull();await state.reload();
 expect(state.getSnapshot()?.project.id).toBe('project-b');
 expect((fetcher.mock.calls[1][1]?.headers as Record<string,string>)['x-project-id']).toBe('project-b');
 expect(sessionStorage.getItem('workbench-project')).toBe('project-b');
});
