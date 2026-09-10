import { expect, it } from 'vitest';
import { mergeConflicts, resolveSegments, mergeResolutionSchema } from '../src/shared/workspaceMerge';
import { mergeTrees, type DesignObject } from '../src/shared/model';

const entity: DesignObject = { id:'doc',kind:'object',title:'合并测试',path:'doc.md',collection:null,fields:{},body:'' };

it('逐块解决正文冲突，保留双方非冲突修改与末尾换行',()=>{
 const base={doc:{...entity,body:'start\nbase\nkeep\nkeep2\nlast\n'}};
 const ours={doc:{...entity,body:'start\nours\nkeep\nkeep2\nmy last\n'}};
 const theirs={doc:{...entity,body:'team start\nteam\nkeep\nkeep2\nlast\n'}};
 const merged=mergeTrees(base,ours,theirs);
 const conflict=mergeConflicts(merged.conflicts,base,ours,theirs)[0];
 expect(conflict.path).toBe('/doc/body');
 expect(resolveSegments(conflict.segments!,{})).toBeUndefined();
 const choices=Object.fromEntries(conflict.segments!.flatMap((segment,index)=>'text' in segment?[]:[[index,['team start','semantic result']]]));
 expect(resolveSegments(conflict.segments!,choices)).toBe('team start\nsemantic result\nkeep\nkeep2\nmy last\n');
});

it('多个冲突必须全部解决，允许选择删除块',()=>{
 const segments=[{base:['a'],ours:[],theirs:['b']},{text:['context']},{base:['c'],ours:['d'],theirs:['e']}];
 expect(resolveSegments(segments,{0:[]})).toBeUndefined();
 expect(resolveSegments(segments,{0:[],2:['custom']})).toBe('context\ncustom');
});

it('自定义结果接受 JSON，包括空文本与 null，但不接受缺失值',()=>{
 for(const value of ['',null,0,false,[],{title:'merged'}]) expect(mergeResolutionSchema.parse({value})).toEqual({value});
 expect(mergeResolutionSchema.safeParse({}).success).toBe(false);
 expect(mergeResolutionSchema.safeParse('custom').success).toBe(false);
});
