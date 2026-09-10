import { mkdirSync, readFileSync, writeFileSync, existsSync, openSync, closeSync, unlinkSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';

const commands = ['connect','schema','find','read','query','edit','history','versions','control','inspiration'];
const routes = Object.fromEntries(commands.map(name => [name, ['POST', '/api/agent/' + name]]));
routes.release = ['POST','/api/agent/control']; routes.resume = ['POST','/api/agent/control'];
const args = process.argv.slice(2);
let command, helpName, wantsHelp = false;
const flags = {};
let secret;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const hash = value => createHash('sha256').update(value).digest('hex');
const remoteHttp = url => url.protocol === 'http:' && !['127.0.0.1','localhost','[::1]'].includes(url.hostname);
const trustedTransport = (url, allowedOrigin) => url.protocol === 'https:' || (url.protocol === 'http:' && (!remoteHttp(url) || allowedOrigin === url.origin));
const read = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const save = (file, data) => {
  const temporary = file + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
};
async function main() {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') { wantsHelp = true; continue; }
    if (arg === '--allow-insecure-http') {
      if (Object.hasOwn(flags, arg)) fail('ARGUMENT', 'Duplicate option: ' + arg);
      flags[arg] = true; continue;
    }
    if (arg.startsWith('--')) {
      if (!['--profile','--url','--token-env','--input','--json','--task','--query'].includes(arg) || args[index + 1] === undefined || Object.hasOwn(flags,arg)) fail('ARGUMENT', 'Invalid or duplicate option: ' + arg);
      flags[arg] = args[++index];
    } else if (!command) command = arg;
    else if (command === 'help' && !helpName) helpName = arg;
    else fail('ARGUMENT', 'Unexpected positional argument');
  }
  if (wantsHelp) { helpName = command; command = 'help'; }
  if (!command || command === 'help') {
    if (helpName === 'configure') return { usage: 'configure --profile NAME --url ORIGIN --token-env ENV_NAME [--allow-insecure-http]', security: 'HTTPS by default. Remote HTTP requires explicit user approval for this exact origin before using --allow-insecure-http. Credentials and content are unencrypted. Existing profiles are never overwritten; use a new profile to change origin or switch to HTTPS.' };
    if (helpName) {
      const contractFile = new URL('./contracts.json', import.meta.url);
      if (existsSync(contractFile)) {
        const entry = read(contractFile)[helpName];
        if (!entry) fail('ARGUMENT', 'Unknown help topic');
        return entry;
      }
      command = 'schema'; flags['--json'] = JSON.stringify({name: helpName});
    } else return { commands: ['configure','new-task','help',...Object.keys(routes)], usage: 'node agent.mjs COMMAND [--json JSON | --input FILE | --input -] [--task ID]; help COMMAND or help edit.field; global --profile may precede command', configuration: 'configure --url ORIGIN --token-env ENV_NAME [--allow-insecure-http]; remote HTTP requires explicit user approval and sends credentials unencrypted; approval applies only to the configured origin; secrets only come from that environment variable; WORKBENCH_CONFIG_HOME isolates all local configuration' };
  }
  if (flags['--allow-insecure-http'] && command !== 'configure') fail('ARGUMENT', '--allow-insecure-http is for configure only');
  if (flags['--input'] && flags['--json']) fail('ARGUMENT', 'Choose --input or --json');
  if (command !== 'configure' && (flags['--url'] || flags['--token-env'])) fail('ARGUMENT', 'Connection options are for configure only');
  if (flags['--query'] && command !== 'find') fail('ARGUMENT', '--query is not supported by this command');
  const directory = resolve(process.env.WORKBENCH_CONFIG_HOME || join(homedir(), '.lunareat-workbench'));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const profile = flags['--profile'] || 'default';
  if (!/^[a-zA-Z0-9_-]{1,60}$/.test(profile)) fail('ARGUMENT', 'Invalid profile name');
  const configFile = join(directory, profile + '.json');
  if (command === 'configure') {
    if (existsSync(configFile)) fail('CONFIG_EXISTS', 'Profile exists; inspect it or choose another profile, do not overwrite blindly');
    const url = new URL(flags['--url']);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('ARGUMENT', 'Use the workbench origin without credentials, query or path');
    if (flags['--allow-insecure-http'] && !remoteHttp(url)) fail('ARGUMENT', '--allow-insecure-http is only for an explicitly approved remote HTTP origin');
    const insecureHttpOrigin = flags['--allow-insecure-http'] ? url.origin : undefined;
    if (!trustedTransport(url, insecureHttpOrigin)) fail('HTTPS_REQUIRED', 'Remote workbenches require HTTPS by default. Only after explicit user approval for this origin, configure with --allow-insecure-http; credentials and content will be sent unencrypted.');
    const tokenEnv = flags['--token-env'] || 'WORKBENCH_TOKEN';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) fail('ARGUMENT', 'Invalid environment variable name');
    writeFileSync(configFile, JSON.stringify({ url: url.origin, tokenEnv, ...(insecureHttpOrigin ? { insecureHttpOrigin } : {}) }, null, 2), { mode: 0o600, flag: 'wx' });
    return { configured: true, profile, url: url.origin, tokenEnv, ...(insecureHttpOrigin ? { warning: 'HTTP sends credentials and content unencrypted. Approval applies only to this origin. Use a short-lived, least-privilege credential; switch to HTTPS and revoke it afterward.' } : {}), next: 'Address configured. Provide the credential securely in this environment variable, then run connect. No content has been accessed.' };
  }
  const config = read(configFile);
  const origin = new URL(config.url);
  if (origin.origin !== config.url || origin.username || origin.password || !trustedTransport(origin, config.insecureHttpOrigin)) fail('CONFIG_INVALID', 'Untrusted connection URL; remote HTTP requires explicit approval saved for this exact origin');
  secret = process.env[config.tokenEnv];
  if (!secret) fail('CREDENTIAL_REQUIRED', 'Address configured; waiting for credential. Set the configured credential environment variable securely in the client process; never paste credentials into chat. No request was sent.');
  const binding = hash(config.url + '\n' + secret);
  const taskDirectory = join(directory, profile + '-tasks');
  if (command === 'new-task') {
    mkdirSync(taskDirectory, { recursive: true, mode: 0o700 });
    const taskId = randomUUID();
    save(join(taskDirectory, taskId + '.json'), { taskId, binding });
    return { taskId, next: 'Reuse this task ID for this editing task only. Creating it does not acquire control.' };
  }
  if (!routes[command]) fail('ARGUMENT', 'Unknown command; run help');
  const [method, path] = routes[command];
  let payload = flags['--json'] ? JSON.parse(flags['--json']) : flags['--input'] ? read(flags['--input'] === '-' ? 0 : resolve(flags['--input'])) : {};
  if (flags['--query']) payload.query = flags['--query'];
  if (['release','resume'].includes(command)) payload.action = command === 'release' ? 'release' : 'request';
  const controlled = command === 'edit' && payload.mode !== 'preview' || command === 'history' && ['undo','redo'].includes(payload.action) || command === 'versions' && ['publish','refresh','discard','withdraw'].includes(payload.action) || command === 'inspiration' && payload.action === 'promote' || ['release','resume'].includes(command) || command === 'control' && ['release','request'].includes(payload.action);
  const mutation = controlled || command === 'versions' && payload.action === 'sync' || command === 'inspiration' && payload.action === 'write';
  const taskRequired = controlled || mutation;
  const releasing = command === 'release' || command === 'control' && payload.action === 'release';
  const resuming = command === 'resume' || command === 'control' && payload.action === 'request';
  const intentDigest = hash(JSON.stringify({command, payload}));
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') fail('ARGUMENT', 'Input must be a JSON object');
  {
    const contractFile = new URL('./contracts.json', import.meta.url);
    if (existsSync(contractFile)) {
      const name = ['release','resume'].includes(command) ? 'control' : command;
      const catalog = read(contractFile);
      const topic = ['versions','inspiration'].includes(name) && payload.action ? name + '.' + payload.action : name;
      const contract = catalog[topic] || catalog[name];
      const shape = contract?.input?.properties ? contract.input : contract?.input?.oneOf?.find(option => option.properties?.action?.const === payload.action);
      if (shape?.properties) {
        const unexpected = Object.keys(payload).filter(key => !Object.hasOwn(shape.properties, key));
        if (unexpected.length) fail('INVALID_INPUT', 'Unknown input keys: ' + unexpected.join(', ') + '. Run help ' + topic + '. Expected top-level keys: ' + Object.keys(shape.properties).join(', '));
      }
    }
  }
  if (['taskId','writeSessionId'].some(key => key in payload)) fail('ARGUMENT', 'Session fields are managed by the client, not input JSON');
  let state, stateFile, lockFile, lock;
  if (taskRequired) {
    const taskId = flags['--task'];
    if (!taskId || !/^[0-9a-f-]{36}$/.test(taskId)) fail('TASK_REQUIRED', 'Run new-task and supply --task ID');
    stateFile = join(taskDirectory, taskId + '.json');
    lockFile = stateFile + '.lock';
    try { lock = openSync(lockFile, 'wx', 0o600); } catch { fail('TASK_BUSY', 'This task is in use. After a crashed process, verify it has exited before removing only this task lock file.'); }
  }
  try {
    if (taskRequired) {
      state = read(stateFile);
      if (state.binding !== binding) fail('TASK_IDENTITY_CHANGED', 'Connection or credential changed; do not reuse this task');
      if (state.closed) fail('TASK_CLOSED', 'Task released; start a new task for new work');
      if (state.interrupted && !resuming && !releasing) fail('WRITE_SESSION_INTERRUPTED', 'Control was interrupted. Stop and report to the user; resume only after permission, then reread.');
      if (releasing && !state.writeSessionId && !state.pending) { state.closed = true; save(stateFile, state); return { released: true, acquired: false }; }
      if (command === 'release' || command === 'resume') payload.action = command === 'release' ? 'release' : 'request';
      if (controlled) payload = { ...payload, taskId: state.taskId, ...(state.writeSessionId ? { writeSessionId: state.writeSessionId } : {}) };
    }
    if (state) {
      {
        if (state.pending && state.pending.intent !== intentDigest) fail('REQUEST_UNCERTAIN', 'Retry the exact previous command and input before doing anything else.');
        if (mutation && !releasing && !resuming) payload.requestId ||= state.pending?.requestId || randomUUID();
        state.pending = { intent: intentDigest, requestId: payload.requestId };
      }
      save(stateFile, state);
    }

    let response, result;
    for (let attempt = 0; attempt < 21; attempt++) {
      try {
        response = await fetch(config.url + path, { method, redirect: 'error', signal: AbortSignal.timeout(15000), headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
        result = await response.json();
      } catch { fail('REQUEST_UNCERTAIN', 'Network or response failure. Reads can retry; mutations must retry the identical request. Check connection, do not regenerate requestId.'); }
      if (result.code !== 'CONTROL_HANDOFF_PENDING' || attempt === 20) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (state) {
      if (response.status < 500) delete state.pending;
      if (result.writeSessionId) state.writeSessionId = result.writeSessionId;
      if (result.code?.startsWith('WRITE_SESSION_')) state.interrupted = true;
      if (response.ok && resuming) state.interrupted = false;
      if (response.ok && releasing) state.closed = true;
      save(stateFile, state);
    }
    if (!response.ok) { process.exitCode = 1; return { ok: false, status: response.status, ...result }; }
    if (payload.requestId && result && typeof result === 'object') result.requestId = payload.requestId;
    return Array.isArray(result) ? { ok: true, items: result } : { ok: true, ...result };
  } finally {
    if (lock !== undefined) { closeSync(lock); unlinkSync(lockFile); }
  }
}
try { const result = await main(); console.log(JSON.stringify(result).replaceAll(secret || '\u0000', '[REDACTED]')); }
catch (error) { process.exitCode = 1; console.log(JSON.stringify({ ok: false, code: error.code || 'CLIENT_ERROR', error: error.code ? error.message : 'Invalid configuration or input. Run help and inspect non-secret configuration.' }).replaceAll(secret || '\u0000', '[REDACTED]')); }
