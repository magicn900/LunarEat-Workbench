import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { unzipSync, strFromU8 } from 'fflate';
import { streamZip } from '../src/server/zipStream';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'workbench-zip-stream-')); });
afterEach(async () => { if (directory.startsWith(join(tmpdir(), 'workbench-zip-stream-'))) await rm(directory, { recursive: true, force: true }); });
it('按块读取文件，生成兼容的 ZIP 并保留原始字节与中文文件名', async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024, 37), path = join(directory, 'image'); await writeFile(path, bytes);
    const stream = streamZip([{ name: 'images/test.png', source: path }, { name: '文档.md', source: Buffer.from('markdown') }]);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(chunks.length).toBeGreaterThan(10);
    const files = unzipSync(Buffer.concat(chunks)); expect(Buffer.from(files['images/test.png'])).toEqual(bytes); expect(strFromU8(files['文档.md'])).toBe('markdown');
});
it('慢消费者不会让整个附件进入输出缓冲，取消后流会关闭', async () => {
    const path = join(directory, 'large'); await writeFile(path, Buffer.alloc(8 * 1024 * 1024));
    const controller = new AbortController(), stream = streamZip([{ name: 'large.png', source: path }], controller.signal);
    const errors: Error[] = []; stream.on('error', error => errors.push(error));
    stream.read(0);
    await expect.poll(() => stream.readableLength).toBeGreaterThan(0);
    expect(stream.readableLength).toBeLessThanOrEqual(128 * 1024);
    const closed = new Promise<void>(resolve => stream.once('close', resolve)); controller.abort(); await closed;
    expect(stream.destroyed).toBe(true); expect(errors[0].name).toBe('AbortError');
});
it('文件读取失败会结束流，不生成看似成功的残缺下载', async () => {
    const stream = streamZip([{ name: 'missing', source: join(directory, 'missing') }]);
    stream.resume(); await expect(once(stream, 'end')).rejects.toThrow();
});
