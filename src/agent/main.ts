import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
const base = process.env.WORKBENCH_URL || 'http://127.0.0.1:14311';
const token = process.env.WORKBENCH_TOKEN;
if (!token)
    throw new Error('缺少 WORKBENCH_TOKEN');
const server = new McpServer({ name: 'design-workbench', version: '1.0.0' });
let taskId = randomUUID(), writeSessionId: string | undefined;
let interrupted = false;
const writePaths = new Set(['/api/workspace/discard','/api/workspace/operations','/api/workspace/undo','/api/workspace/history-step','/api/workspace/refresh','/api/publish','/api/changes/withdraw','/api/inspiration/promote']);
async function request(path: string, body?: unknown) {
    const response = await fetch(base + path,{method:body ? 'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body ? JSON.stringify(body):undefined});
    return {ok:response.ok,result:await response.json()};
}
async function call(path: string, body?: unknown) {
    const writing = writePaths.has(path);
    const payload = writing ? {...body as object,taskId,writeSessionId} : body;
    let response = await request(path,payload);
    const handoff=writing || (path==='/api/workspace/control' && (body as any)?.action==='request');
    for(let attempt=0; handoff && response.result.code === 'CONTROL_HANDOFF_PENDING' && attempt<60; attempt++) {
        await new Promise(resolve => setTimeout(resolve,500));
        response = await request(path,payload);
    }
    if(response.result.writeSessionId) { writeSessionId=response.result.writeSessionId; interrupted=false; }
    if(response.result.code?.startsWith('WRITE_SESSION_')) interrupted=true;
    return {content:[{type:'text' as const,text:JSON.stringify(response.result)}],isError:!response.ok};
}
const heartbeat = setInterval(async () => {
    if(!writeSessionId || interrupted) return;
    try { const result=await request('/api/workspace/control',{action:'renew',writeSessionId}); if(!result.ok) interrupted=true; } catch { }
},10000);
heartbeat.unref();
server.registerTool('workspace_write_session', {
    description:'结束一轮修改时必须 release 释放控制权。首次写入自动获取会话；ID 与续租由客户端维护。人工收回或超时后，只能明确 request 重新申请，不得盲目重试；获准后先重新读取内容。',
    inputSchema:{action:z.enum(['release','request']),title:z.string().max(200).optional()}
},async input => {
    const result=await call('/api/workspace/control',{...input,taskId,writeSessionId});
    if(!result.isError && input.action==='release') {writeSessionId=undefined;taskId=randomUUID();interrupted=false;}
    return result;
});
server.registerTool('workspace_read', { description: '读取自己的工作区。只包含设计内容，不包含共享灵感池。', inputSchema: {} }, () => call('/api/workspace'));
server.registerTool('workspace_search', { description: '搜索正式策划工作区，不搜索灵感池。', inputSchema: { query: z.string() } }, ({ query }) => call('/api/search?q=' + encodeURIComponent(query)));
server.registerTool('workspace_apply', { description: '原子提交变更。put 需 entity/expected；field 需 id/key/expected/value；patch 需 id/before/after（原文必须唯一）；delete 需 id/expected。首次修改自动取得工作区控制权，等待 Web 保存；整轮会话统一撤销，结束后调用 workspace_write_session release。requestId 用于幂等。', inputSchema: { requestId: z.string(), groupId: z.string().optional(), operations: z.array(z.record(z.string(), z.unknown())) } }, input => call('/api/workspace/operations', input));
server.registerTool('workspace_history', { description: '读取人类与 Agent 变更组和语义差异。', inputSchema: {} }, () => call('/api/history'));
server.registerTool('workspace_undo', { description: '安全撤销变更组，有后续冲突时拒绝覆盖。', inputSchema: { requestId: z.string(), groupId: z.string() } }, input => call('/api/workspace/undo', input));
server.registerTool('design_preview', { description: '读取发布差异及 main 合并冲突。', inputSchema: {} }, () => call('/api/publish/preview'));
const discardInput = { head: z.string(), base: z.string(), main: z.string(), targets: z.array(z.object({ id: z.string(), key: z.string().optional() })).min(1).max(500) };
server.registerTool('design_withdraw', { description: '仅在用户明确要求时，将本人最新发布撤回草稿。先检查 design_changes 的 withdrawalBlocker（null 才可撤回）及 revision；不能有依赖工作区、同步历史或新草稿修改。删除发布记录，保留草稿内容、名称和简介。受写入控制保护，完成后释放控制权。', inputSchema: { id: z.string(), revision: z.string() } }, input => call('/api/changes/withdraw', input));
server.registerTool('workspace_discard_preview', { description: '先读取 design_preview 的 review，选择差异 key 或省略 key 丢弃整个文件。预览关联影响，不写入；检查返回 targets、dependencies 和 issues。', inputSchema: discardInput }, input => call('/api/workspace/discard-preview', input));
server.registerTool('workspace_discard', { description: '按已检查的预览 targets 丢弃草稿修改，恢复草稿基线而非覆盖最新 main。必须明确同意关联范围；受写入会话保护且可撤销。仅取得控制权不会改变预览，其他修改后须重新预览。', inputSchema: { ...discardInput, requestId: z.string() } }, input => call('/api/workspace/discard', input));
server.registerTool('design_publish', { description: '直接发布预览过的设计，不经过审批；需 design.publish 权限。', inputSchema: { requestId: z.string(), head: z.string(), main: z.string(), title: z.string(), description: z.string() } }, input => call('/api/publish', input));
server.registerTool('workspace_refresh', { description: '更新工作区基础版本；冲突必须显式选择 ours/theirs，先读取发布预览。', inputSchema: { requestId: z.string(), head: z.string(), main: z.string(), resolutions: z.record(z.string(), z.enum(['ours', 'theirs'])).optional() } }, input => call('/api/workspace/refresh', input));
server.registerTool('design_changes', { description: '读取发布记录、固定正式设计版本与实现同步状态。', inputSchema: {} }, () => call('/api/changes'));
server.registerTool('design_confirm_sync', { description: '确认已同步至实现。平台不会验证仓库/commit；不得在未检查实现时声称已同步。active=false 重新标记为待同步至实现，保留历史记录。', inputSchema: { requestId: z.string(), ids: z.array(z.string()), repository: z.string(), commit: z.string(), note: z.string(), active: z.boolean() } }, input => call('/api/changes/confirm', input));
server.registerTool('inspiration_search', { description: '显式查询独立的项目共享灵感池。这些内容不是正式设计依据。', inputSchema: { query: z.string().default('') } }, ({ query }) => call('/api/inspiration?q=' + encodeURIComponent(query)));
server.registerTool('inspiration_write', { description: '写入共享便签，不进入版本控制。修改/删除必须带当前 id/version。', inputSchema: { requestId: z.string(), id: z.string().optional(), version: z.number().optional(), title: z.string(), body: z.string(), tags: z.array(z.string()), remove: z.boolean().optional() } }, input => call('/api/inspiration', input));
server.registerTool('inspiration_promote', { description: '复制共享便签到自己的版本化草稿，原便签保留且不双向同步。', inputSchema: { requestId: z.string(), id: z.string(), version: z.number() } }, input => call('/api/inspiration/promote', input));
server.registerTool('workspace_redo',{description:'重做已撤销的修改，支持 scope 对象 ID 或 collections。',inputSchema:{requestId:z.string(),scope:z.string().optional()}},input=>call('/api/workspace/history-step',{...input,direction:'redo'}));
await server.connect(new StdioServerTransport());
