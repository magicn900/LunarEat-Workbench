import { Store } from './store.js';
import { createCodec } from './codec.js';
import { Service } from './service.js';
import { createApp } from './app.js';
import { acquireRuntimeLock } from './runtime.js';
const directory = process.env.WORKBENCH_DATA || '.local-data/demo';
const release = acquireRuntimeLock(directory);
process.on('exit', release);
const store = new Store(directory);
const codec = await createCodec();
const app = await createApp(new Service(store, codec));
const address = await app.listen({ port: Number(process.env.PORT) || 14311, host: process.env.HOST || '127.0.0.1' });
console.log('工作台运行于 ' + address);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, async () => { await app.close(); await codec.close(); store.close(); process.exit(0); });
