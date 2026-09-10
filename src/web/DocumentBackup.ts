import type { Node as ProseNode } from '@milkdown/prose/model';

export class DocumentBackup {
    private pending: ProseNode | undefined;
    private persisted: ProseNode | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    constructor(private key: string, private serialize: (doc: ProseNode) => string, private onFailure: () => void) {}
    schedule(doc: ProseNode) {
        if (doc === this.persisted) { this.cancel(); return; }
        this.pending = doc;
        this.timer ??= setTimeout(() => this.flush(), 250);
    }
    flush() {
        clearTimeout(this.timer); this.timer = undefined;
        const doc = this.pending;
        if (!doc) return;
        try {
            localStorage.setItem(this.key, this.serialize(doc));
            this.persisted = doc; this.pending = undefined;
        } catch { this.onFailure(); }
    }
    clear() {
        this.cancel(); this.persisted = undefined;
        try { localStorage.removeItem(this.key); } catch { this.onFailure(); }
    }
    cancel() {
        clearTimeout(this.timer); this.timer = undefined; this.pending = undefined;
    }
}
