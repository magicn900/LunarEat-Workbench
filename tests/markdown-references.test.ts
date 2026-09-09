import { expect, it } from 'vitest';
import { markdownReferences } from '../src/shared/markdownReferences';
import { deletionBlockers } from '../src/shared/deletion';
import type { DesignObject } from '../src/shared/model';
it('只提取实际链接和独立嵌入，包括引用式链接和嵌套块',()=>{
 const body='[真实](doc:page)\n\n[引用][ref]\n\n[ref]: doc:reference\n\n> :::doc[embedded]\n\n- :::view[table]\n\n示例 :::view[inline]\n\n`[代码](doc:code)`\n\n    :::view[indented]\n\n~~~\n[代码](doc:fenced)\n:::view[fenced-view]\n~~~\n\n<!-- [隐藏](doc:comment) -->\n\n[unused]: doc:unused';
 expect(markdownReferences(body)).toEqual({documents:['page','reference','embedded'],views:['table']});
});
it('删除依赖与发布使用同一 Markdown 语义，不误计代码示例',()=>{
 const object:DesignObject={id:'page',kind:'object',title:'页面',path:'page.md',collection:null,fields:{},body:'```md\n:::view[target]\n[示例](doc:target)\n```'};
 expect(deletionBlockers({page:object},new Set(['target']))).toEqual([]);
 expect(deletionBlockers({page:{...object,body:':::view[target]'}},new Set(['target']))).toHaveLength(1);
 expect(deletionBlockers({page:{...object,body:'[真实](doc:target)'}},new Set(['target']))).toHaveLength(1);
});



it('调用方修改结果不会污染后续引用解析',()=>{const result=markdownReferences('[页面](doc:target)');result.documents.push('wrong');expect(markdownReferences('[页面](doc:target)').documents).toEqual(['target']);});
