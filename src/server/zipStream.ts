import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { Zip, ZipPassThrough } from 'fflate';

type Entry = { name: string; source: string | Uint8Array };
export function streamZip(entries: Entry[], signal?: AbortSignal): Readable {
    async function* generate() {
        const chunks: Uint8Array[] = [];
        const zip = new Zip((error, data) => { if (error) throw error; if (data.length) chunks.push(data); });
        try {
            for (const entry of entries) {
                signal?.throwIfAborted();
                const file = new ZipPassThrough(entry.name);
                zip.add(file);
                if (typeof entry.source === 'string') {
                    const input = createReadStream(entry.source, { highWaterMark: 64 * 1024, signal });
                    try {
                        for await (const chunk of input) {
                            signal?.throwIfAborted();
                            file.push(chunk, false);
                            for (const output of chunks.splice(0)) yield output;
                        }
                    } finally { input.destroy(); }
                    file.push(new Uint8Array(), true);
                } else file.push(entry.source, true);
                for (const output of chunks.splice(0)) yield output;
            }
            zip.end();
            for (const output of chunks.splice(0)) yield output;
        } finally { zip.terminate(); }
    }
    return Readable.from(generate(), { objectMode: false, highWaterMark: 64 * 1024, signal });
}
