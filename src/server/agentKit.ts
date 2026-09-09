import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';


import { Fault } from './fault.js';
import { agentContractCatalog } from '../shared/agentContract.js';

const files = ['SKILL.md', 'scripts/agent.mjs', 'references/connection.md', 'references/editing.md', 'references/recovery.md', 'references/publishing.md', 'references/inspiration.md'];
export const agentConnection = { manifest: '/api/agent/kit/manifest.json', connect: '/api/agent/connect' };
export function registerAgentKit(app: FastifyInstance) {
    const contents = new Map(files.map(file => [file, readFileSync(new URL('../../public/skills/lunareat-workbench/' + file, import.meta.url))]));
    contents.set('scripts/contracts.json', Buffer.from(JSON.stringify(agentContractCatalog())));
    app.get('/api/agent/kit/manifest.json', async () => ({ name: 'lunareat-workbench', ...agentConnection, runtime: 'Node.js >=24', files: [...contents.keys()].map(path => ({ path, sha256: createHash('sha256').update(contents.get(path)!).digest('hex') })) }));
    app.get('/api/agent/kit/*', async (request, reply) => {
        const file = (request.params as { '*': string })['*'];
        const content = contents.get(file);
        if (!content) throw new Fault(404, '接入文件不存在');
        return reply.type('text/plain; charset=utf-8').send(content);
    });
}
