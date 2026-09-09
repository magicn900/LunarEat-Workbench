import { existsSync } from 'node:fs';
import { Store } from '../src/server/store.js';
import { seed } from '../src/server/seed.js';
import { createUser, passwordHash } from '../src/server/auth.js';
import { updateAccountAccess } from '../src/server/administration.js';
import { createCodec } from '../src/server/codec.js';
import { Service } from '../src/server/service.js';
import { createApp } from '../src/server/app.js';
const root='.local-data/e2e-'+Date.now();const store=new Store(root);seed(store,'e2e-password-123');createUser(store,'settings-user','e2e-password-123','demo');store.db.prepare('INSERT INTO users VALUES (?,?,?)').run('test-admin','test-admin',passwordHash('e2e-password-123'));store.db.transaction(()=>updateAccountAccess(store,'test-bootstrap','test-admin',true,false))();const codec=await createCodec();const app=await createApp(new Service(store,codec), process.env.WORKBENCH_TEST_WEB_ROOT || 'dist');await app.listen({port:14319,host:'127.0.0.1'});process.on('SIGTERM',async()=>{await app.close();await codec.close();store.close();process.exit();});
