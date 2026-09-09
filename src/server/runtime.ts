import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
export function acquireRuntimeLock(directory: string) {
    const root = resolve(directory);
    mkdirSync(root, { recursive: true });
    const path = join(root, 'service.lock'), nonce = randomUUID();
    if (existsSync(path)) {
        const previous = JSON.parse(readFileSync(path, 'utf8'));
        let alive = previous.pid !== process.pid;
        try {
            if (alive) process.kill(previous.pid, 0);
        }
        catch (error: any) {
            if (error.code === 'ESRCH')
                alive = false;
            else
                throw error;
        }
        if (alive)
            throw new Error('此数据目录已有服务运行；备份和管理操作需先停止服务。');
        unlinkSync(path);
    }
    writeFileSync(path, JSON.stringify({ pid: process.pid, nonce }), { flag: 'wx', mode: 0o600 });
    return () => { if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).nonce === nonce)
        unlinkSync(path); };
}
