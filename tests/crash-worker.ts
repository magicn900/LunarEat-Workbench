import { Store } from '../src/server/store.js';
import { Service } from '../src/server/service.js';
import { createCodec } from '../src/server/codec.js';
import { randomUUID } from 'node:crypto';
const store=new Store(process.env.CRASH_DATA!);const codec=await createCodec();const service=new Service(store,codec);service.mutate(JSON.parse(process.env.CRASH_ACTOR!),randomUUID(),[{type:'field',id:'frost',key:'cost',expected:2,value:9}]);process.stdout.write('PERSISTED\n');setInterval(()=>{},1000);
