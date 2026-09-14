import Fastify from 'fastify';
import { registerAssetRoutes } from './assetRoutes.js';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { mergeResolutionSchema } from '../shared/workspaceMerge.js';
import { documentSchemaVersion } from '../shared/embeds.js';
import { actorFor, checkPassword, Fault, issueToken, capabilities } from './auth.js';
import type { Service, Operation } from './service.js';
import { entitySchema, serialize, type Actor } from '../shared/model.js';
import { requireScope } from './auth.js';
import { accountAccess } from './auth.js';
import { registerAdministration } from './administration.js';
import { registerLifecycle } from './lifecycle.js';
import { registerSchedule } from './schedule.js';
import { registerAccountSettings } from './accountSettings.js';
import { registerAgentKit, agentConnection } from './agentKit.js';
import { registerAgentCollaboration } from './agentCollaboration.js';
const requestId = z.string().min(1).max(150);
const discardSchema = z.object({ head: z.string(), base: z.string(), main: z.string(), targets: z.array(z.object({ id: z.string().min(1), key: z.string().optional() })).min(1).max(500) });
export async function createApp(service: Service, webRoot = 'dist') {
    const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
    const { store } = service;
    const controlled = (request: any, operation: (current: Actor) => unknown) => {
        const current = actor(request);
        const input = z.object({ taskId: z.string().min(1).max(150).optional(), writeSessionId: z.string().uuid().optional() }).parse(request.body || {});
        return service.execute(current,input,() => operation(current));
    };
    await app.register(cookie);
    await app.register(websocket);
    app.addHook('onSend', async (_request, reply, payload) => { reply.header('X-Content-Type-Options', 'nosniff'); reply.header('Referrer-Policy', 'same-origin'); reply.header('X-Frame-Options', 'DENY'); reply.header('Cache-Control', 'no-store'); return payload; });
    const attempts = new Map<string, {
        count: number;
        until: number;
    }>();
    const actor = (request: any): Actor => actorFor(store, request.headers.authorization?.replace(/^Bearer /, '') || request.cookies.session || '', !!request.headers.authorization, request.headers['x-project-id'] || (request.url.startsWith('/events?') ? (request.query as any).projectId : undefined));
    app.setErrorHandler((error: any, request, reply) => {
        if (error instanceof z.ZodError) return reply.code(400).send({ error: '请求格式不合法', code: 'INVALID_INPUT', requiredAction: 'read_command_schema', retryable: false, details: error.issues.slice(0, 20) });
        const status = error.status || error.statusCode || 500;
        if (status >= 500) console.error({ requestId: request.id, error });
        reply.code(status).send({ error: status >= 500 ? '服务端处理失败，请保留输入并提供请求编号排查' : error.message, requestId: request.id, details: status >= 500 ? undefined : error.details, code: error.details?.code || (status >= 500 ? 'INTERNAL_ERROR' : undefined), retryable: error.details?.retryable, requiredAction: error.details?.requiredAction });
    });
    registerAgentKit(app);
    registerAgentCollaboration(app, service, actor);
    app.addHook('onRequest', async (request) => {
        if (request.method === 'GET' || request.method === 'HEAD')
            return;
        const origin = request.headers.origin;
        if (origin && origin !== (process.env.WORKBENCH_ORIGIN || 'http://' + request.headers.host))
            throw new Fault(403, '请求来源不可信');
        if (request.headers['sec-fetch-site'] === 'cross-site')
            throw new Fault(403, '禁止跨站写入');
        if (!request.headers.authorization && !request.headers['x-workbench-client'])
            throw new Fault(403, '缺少客户端请求标识');
    });
    app.get('/api/health', async () => ({ ok: true }));
    app.post('/api/login', async (request, reply) => {
        const input = z.object({ username: z.string(), password: z.string().max(1024) }).parse(request.body);
        const key = request.ip;
        let limit = attempts.get(key);
        if (!limit || limit.until < Date.now()) {
            limit = { count: 0, until: Date.now() + 60000 };
            attempts.set(key, limit);
        }
        if (++limit.count > 15)
            throw new Fault(429, '登录尝试过多，请稍后重试');
        const user = store.db.prepare('SELECT * FROM users WHERE username=?').get(input.username) as any;
        if (!user || !checkPassword(input.password, user.password))
            throw new Fault(401, '账号或密码不正确');
        accountAccess(store, user.id);
        const token = randomBytes(32).toString('base64url');
        store.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(store.hash(token), user.id, Date.now() + 7 * 86400000);
        reply.setCookie('session', token, { httpOnly: true, sameSite: 'strict', secure: process.env.COOKIE_SECURE === 'true', path: '/', maxAge: 7 * 86400 });
        return { ok: true };
    });
    app.post('/api/logout', async (request, reply) => { store.db.prepare('DELETE FROM sessions WHERE hash=?').run(store.hash(request.cookies.session || '')); reply.clearCookie('session', { path: '/' }); return { ok: true }; });
    app.get('/api/workspace', async request => service.snapshot(actor(request), z.object({ since: z.string().max(200).optional() }).parse(request.query).since));
    registerAdministration(app, store);
    registerLifecycle(app, store);
    registerSchedule(app, store, actor);
    registerAssetRoutes(app, service);
    registerAccountSettings(app, store);
    app.get('/api/search', async (request) => service.search(actor(request), z.object({ q: z.string().default('') }).parse(request.query).q));
    app.post('/api/workspace/import-preview', async (request) => { const current = actor(request); requireScope(current, 'workspace.read'); const entity = entitySchema.parse(request.body); const before = serialize(entity); if (entity.kind === 'object')
        entity.body = service.codec.serialize(service.codec.parse(entity.body)); return { entity, text: serialize(entity), normalized: before !== serialize(entity) }; });
    app.get('/api/history', async (request) => service.history(actor(request)));
    app.post('/api/workspace/discard-preview', async request => service.discardPreview(actor(request), discardSchema.parse(request.body)));
    app.post('/api/workspace/discard', async request => controlled(request, current => service.discard(current, discardSchema.extend({ requestId }).parse(request.body))));
    app.post('/api/workspace/history-step',async request => {
        const input = z.object({requestId,direction:z.enum(['undo','redo']),scope:z.string().optional(),groupId:z.string().optional()}).parse(request.body);
        return controlled(request,current => service.historyStep(current,input));
    });
    app.post('/api/workspace/control',async request => {
        const current = actor(request);
        const input = z.object({action:z.enum(['request','release','renew','revoke']),writeSessionId:z.string().uuid().optional(),taskId:z.string().min(1).max(150).optional(),title:z.string().max(200).optional()}).parse(request.body);
        return service.control.action(current,service.workspace(current).id,input);
    });
    app.post('/api/workspace/abandon-client', async request => {
        const current = actor(request);
        const input = z.object({ clientId: z.string().uuid(), seen: z.number().int().nonnegative(), confirm: z.literal(true) }).parse(request.body);
        return service.control.abandonClient(current, service.workspace(current).id, input);
    });
    app.post('/api/workspace/presence',async request => {
        const current = actor(request);
        const input = z.object({clientId:z.string().uuid(),dirty:z.boolean(),ack:z.string().optional(),close:z.boolean().optional()}).parse(request.body);
        return service.control.presence(current,service.workspace(current).id,input);
    });
    app.get('/api/documents/:id', async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); const { since } = z.object({ since: z.coerce.number().int().nonnegative().optional() }).parse(request.query); return service.document(actor(request), id, since); });
    app.get('/api/documents/:id/source', async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); return service.documentSource(actor(request), id); });
    app.post('/api/documents/:id/source', async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); const input = z.object({ requestId, expected: z.string(), body: z.string() }).parse(request.body); return controlled(request, current => service.saveDocumentSource(current, id, input)); });
    app.post('/api/documents/:id/steps', async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); const input = z.object({ requestId, schemaVersion: z.number().optional(), version: z.number().int().nonnegative(), steps: z.array(z.unknown()).min(1).max(2000), clientId: z.string().min(1), groupId: z.string().min(1) }).parse(request.body); if (input.schemaVersion !== documentSchemaVersion) throw new Fault(409, '编辑器协议已更新，请保留输入并刷新页面', { code: 'DOCUMENT_SCHEMA_CHANGED' }); return controlled(request,current => service.textSteps(current, id, input)); });
    app.post('/api/workspace/operations', async (request) => { const input = z.object({ requestId, groupId: z.string().optional(), operations: z.array(z.record(z.string(), z.unknown())).min(1).max(500) }).parse(request.body); return controlled(request,current => service.mutate(current, input.requestId, input.operations as Operation[], input.groupId)); });
    app.post('/api/workspace/undo', async (request) => { const input = z.object({ requestId, groupId: z.string() }).parse(request.body); return controlled(request,current => service.undo(current, input.requestId, input.groupId)); });
    app.get('/api/publish/preview', async (request) => service.preview(actor(request)));
    app.post('/api/publish', async request => {
        const input = z.object({ requestId, head: z.string(), main: z.string(), title: z.string().min(1).max(200), description: z.string().max(20000).default('') }).parse(request.body);
        const write = z.object({ taskId: z.string().optional(), writeSessionId: z.string().optional() }).parse(request.body);
        return service.stagePublication(actor(request), input, write, (prepared, control) => {
            const current = actor(request);
            return service.execute(current, control, () => service.publish(current, input, prepared), false);
        });
    });
    app.post('/api/workspace/refresh', async (request) => controlled(request,current => service.refresh(current, z.object({ requestId, head: z.string(), main: z.string(), resolutions: z.record(z.string(), mergeResolutionSchema).optional() }).parse(request.body))));
    app.get('/api/changes', async (request) => service.changes(actor(request)));
    app.post('/api/changes/withdraw', async request => {
        const input = z.object({ id: z.string().min(1), revision: z.string().min(1) }).parse(request.body);
        const current = actor(request);
        const control = z.object({ taskId: z.string().optional(), writeSessionId: z.string().optional() }).parse(request.body);
        return service.execute(current, control, () => service.withdraw(current, input), false);
    });
    app.post('/api/changes/confirm', async (request) => service.confirm(actor(request), z.object({ requestId, ids: z.array(z.string()).min(1), repository: z.string().min(1), commit: z.string().min(1), note: z.string().min(1), active: z.boolean() }).parse(request.body)));
    app.get('/api/inspiration', async (request) => service.notes(actor(request), z.object({ q: z.string().default('') }).parse(request.query).q));
    app.post('/api/inspiration', async (request) => service.note(actor(request), z.object({ requestId, id: z.string().optional(), version: z.number().int().optional(), title: z.string().max(200), body: z.string().max(200000), tags: z.array(z.string()).max(30), remove: z.boolean().optional() }).parse(request.body)));
    app.post('/api/inspiration/promote', async (request) => controlled(request,current => service.promote(current, z.object({ requestId, id: z.string(), version: z.number().int() }).parse(request.body))));
    app.get('/api/settings', async (request) => { const current = actor(request); if (current.kind !== 'human')
        throw new Fault(403, '仅人工会话可以查看设置'); return { connection: agentConnection, scopes: current.scopes, members: store.db.prepare('SELECT u.username,m.can_sync FROM members m JOIN users u ON u.id=m.user_id WHERE m.project_id=?').all(current.projectId), tokens: store.db.prepare('SELECT id,name,scopes,created FROM tokens WHERE user_id=? AND project_id=?').all(current.userId, current.projectId) }; });
    app.post('/api/tokens', async (request) => { const input = z.object({ name: z.string().min(1), scopes: z.array(z.enum(capabilities as [
            string,
            ...string[]
        ])) }).parse(request.body); return issueToken(store, actor(request), input.name, input.scopes); });
    app.post('/api/tokens/revoke', async (request) => { const current = actor(request); if (current.kind !== 'human')
        throw new Fault(403, '仅人工会话可以撤销凭据'); const input = z.object({ id: z.string() }).parse(request.body); store.db.prepare('DELETE FROM tokens WHERE id=? AND user_id=? AND project_id=?').run(input.id, current.userId, current.projectId); return { ok: true }; });
    app.get('/events', { websocket: true }, (socket, request) => {
        let cursor = Number((request.query as any).since) || 0;
        const send = () => { if (socket.readyState !== 1) return; try {
            const current = actor(request);
            const events = service.events(current, cursor);
            for (const event of events) {
                if (socket.bufferedAmount > 1024 * 1024) { socket.close(1013, '连接过慢，请重新同步'); return; }
                socket.send(JSON.stringify(event));
                cursor = event.seq;
            }
            if (events.length < 500) cursor = service.sequence();
            else setImmediate(send);
        }
        catch {
            socket.close(1008, '身份失效');
        } };
        if (request.headers.origin && request.headers.origin !== (process.env.WORKBENCH_ORIGIN || 'http://' + request.headers.host)) {
            socket.close(1008);
            return;
        }
        const unsubscribe = store.subscribe(actor(request).projectId, send);
        const timer = setInterval(send, 2500);
        send();
        socket.on('close', () => { clearInterval(timer); unsubscribe(); });
    });
    const dist = resolve(webRoot);
    if (existsSync(dist)) {
        await app.register(staticFiles, { root: dist });
        app.setNotFoundHandler((request, reply) => { if (request.url.startsWith('/api/'))
            return reply.code(404).send({ error: '接口不存在' }); return reply.sendFile('index.html'); });
    }
    return app;
}
