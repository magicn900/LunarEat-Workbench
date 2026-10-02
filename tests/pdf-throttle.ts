import { Readable, Transform } from 'node:stream';
import type { FastifyInstance } from 'fastify';

export function installPdfThrottle(app: FastifyInstance) {
    const transfers: { url: string; range: string | null; total: number; sent: number; completed: boolean }[] = [];
    app.get('/__test/pdf-transfers', async () => transfers);
    app.addHook('onSend', async (request, reply, payload) => {
        if (request.method !== 'GET' || request.cookies.pdf_slow !== '1' || !/\/export-pdf\/tasks\/[^/]+\/file$/.test(request.url) || !(payload instanceof Readable)) return payload;
        const transfer = { url: request.url, range: request.headers.range || null, total: Number(reply.getHeader('content-length')), sent: 0, completed: false };
        transfers.push(transfer); if (transfers.length > 128) transfers.shift();
        let timer: ReturnType<typeof setTimeout> | undefined, first = true;
        const throttled = new Transform({ transform(chunk: Buffer, _encoding, callback) {
            const delay = first ? 0 : chunk.length / (256 * 1024) * 1000; first = false;
            timer = setTimeout(() => { transfer.sent += chunk.length; callback(null, chunk); }, delay);
        }, destroy(error, callback) { clearTimeout(timer); payload.destroy(); callback(error); } });
        const abort = () => throttled.destroy();
        reply.raw.once('close', abort);
        payload.once('error', error => throttled.destroy(error));
        payload.once('close', () => { if (!payload.readableEnded) throttled.destroy(); });
        throttled.once('end', () => { transfer.completed = true; });
        throttled.once('close', () => { reply.raw.removeListener('close', abort); });
        return payload.pipe(throttled);
    });
}
