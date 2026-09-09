import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { serialize, type Tree } from '../shared/model.js';

function* instructions(tree: Tree, parent: string, title: string): Generator<Buffer> {
    if (parent && !/^[a-f0-9]{40,64}$/.test(parent)) throw new Error('正式版本标识不合法');
    const entities = Object.values(tree);
    const branch = 'refs/workbench-staging/' + randomUUID();
    yield Buffer.from('feature done\n');
    for (const [index, entity] of entities.entries()) {
        const text = serialize(entity);
        yield Buffer.from('blob\nmark :' + (index + 1) + '\ndata ' + Buffer.byteLength(text) + '\n' + text + '\n');
    }
    const message = title + '\n', mark = entities.length + 1;
    yield Buffer.from('commit ' + branch + '\nmark :' + mark + '\ncommitter 工作台 <workbench@localhost> ' + Math.floor(Date.now() / 1000) + ' +0000\ndata ' + Buffer.byteLength(message) + '\n' + message + '\n' + (parent ? 'from ' + parent + '\n' : '') + 'deleteall\n');
    for (const [index, entity] of entities.entries()) yield Buffer.from('M 100644 :' + (index + 1) + ' ' + JSON.stringify(entity.path) + '\n');
    yield Buffer.from('\nget-mark :' + mark + '\nreset ' + branch + '\n\ndone\n');
}
function revision(output: string): string {
    const value = output.trim();
    if (!/^[a-f0-9]{40,64}$/.test(value)) throw new Error('Git 未返回有效版本');
    return value;
}
export function createGitCommit(directory: string, tree: Tree, parent: string, title: string): string {
    return revision(execFileSync('git', ['--git-dir=' + directory, 'fast-import', '--quiet'], { input: Buffer.concat([...instructions(tree, parent, title)]), encoding: 'utf8', maxBuffer: 1024 * 1024 }));
}
export async function createGitCommitAsync(directory: string, tree: Tree, parent: string, title: string): Promise<string> {
    const child = spawn('git', ['--git-dir=' + directory, 'fast-import', '--quiet'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = '', errors = '';
    const timer = setTimeout(() => child.kill(), 60000);
    const completed = new Promise<string>((resolve, reject) => {
        child.once('error', reject);
        child.stdin.on('error', reject);
        child.stdout.on('data', data => { output += data.toString(); if (output.length > 1024) child.kill(); });
        child.stderr.on('data', data => { errors = (errors + data.toString()).slice(-16384); });
        child.once('close', code => {
            if (code !== 0) reject(new Error('Git 发布准备失败: ' + errors));
            else { try { resolve(revision(output)); } catch (error) { reject(error); } }
        });
    });
    const write = async () => {
        let count = 0;
        for (const instruction of instructions(tree, parent, title)) {
            if (!child.stdin.write(instruction)) await once(child.stdin, 'drain');
            if (++count % 32 === 0) await setImmediate();
        }
        child.stdin.end();
    };
    try { const [result] = await Promise.all([completed, write()]); return result; }
    finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
}
