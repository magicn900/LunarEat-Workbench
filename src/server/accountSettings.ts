import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from './store.js';
import { accountPreferences, checkPassword, Fault, passwordHash } from './auth.js';
import { audit, identity } from './administration.js';

export function registerAccountSettings(app: FastifyInstance, store: Store) {
    const attempts = new Map<string, { count: number; until: number }>();
    app.post('/api/account/preferences', async request => {
        const current = identity(store, request);
        const input = z.object({ theme: z.enum(['light', 'dark', 'system']), language: z.enum(['zh-CN', 'en']), version: z.number().int().nonnegative() }).strict().parse(request.body);
        return store.db.transaction(() => {
            const before = accountPreferences(store, current.id);
            if (input.version !== before.version) throw new Fault(409, '设置已在其他页面更新，请重新加载后再修改');
            const next = { ...input, version: before.version + 1 };
            store.db.prepare('INSERT INTO account_preferences VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET theme=excluded.theme,language=excluded.language,version=excluded.version').run(current.id, next.theme, next.language, next.version);
            return next;
        })();
    });
    app.post('/api/account/password', async (request, reply) => {
        const current = identity(store, request);
        const input = z.object({ currentPassword: z.string().min(1).max(1024), newPassword: z.string().min(10).max(1024) }).strict().parse(request.body);
        const now = Date.now();
        for (const [key, limit] of attempts) if (limit.until <= now) attempts.delete(key);
        const limit = attempts.get(current.id) || { count: 0, until: now + 600000 };
        attempts.set(current.id, limit);
        if (++limit.count > 5) throw new Fault(429, '密码验证尝试过多，请稍后重试');
        const user = store.db.prepare('SELECT password FROM users WHERE id=?').get(current.id) as { password: string };
        if (!checkPassword(input.currentPassword, user.password)) throw new Fault(400, '当前密码不正确');
        if (input.currentPassword === input.newPassword) throw new Fault(400, '新密码不能与当前密码相同');
        store.db.transaction(() => {
            store.db.prepare('UPDATE users SET password=? WHERE id=?').run(passwordHash(input.newPassword), current.id);
            store.db.prepare("UPDATE write_sessions SET status='revoked' WHERE owner IN (SELECT id FROM tokens WHERE user_id=?) AND status IN ('active','pending')").run(current.id);
            store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(current.id);
            store.db.prepare('DELETE FROM tokens WHERE user_id=?').run(current.id);
            audit(store, current.username, '本人修改密码并撤销凭据', current.id, {});
        })();
        reply.clearCookie('session', { path: '/' });
        return { ok: true };
    });
}
