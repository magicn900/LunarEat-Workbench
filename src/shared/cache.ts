export class BoundedCache<Value> {
    private readonly entries = new Map<string, { value: Value; size: number }>();
    private bytes = 0;
    constructor(readonly capacity: number, readonly limit = 10000) {}
    get(key: string): Value | undefined {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }
    set(key: string, value: Value, size: number) {
        const previous = this.entries.get(key);
        if (previous) { this.bytes -= previous.size; this.entries.delete(key); }
        if (size > this.capacity) return;
        while (this.entries.size && (this.bytes + size > this.capacity || this.entries.size >= this.limit)) {
            const oldest = this.entries.keys().next().value!;
            this.bytes -= this.entries.get(oldest)!.size;
            this.entries.delete(oldest);
        }
        this.entries.set(key, { value, size });
        this.bytes += size;
    }
    clear() { this.entries.clear(); this.bytes = 0; }
}

