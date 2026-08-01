export type DisposableTile = { texture: { dispose(): void } };

type CacheEntry<T> = {
    tile: T;
    bytes: number;
    /** Live pins (e.g. tiles currently showing this texture). Never evicted while > 0. */
    refs: number;
    lastUse: number;
};

/**
 * Keyed texture cache with a decoded-bytes budget. Entries are pinned by
 * acquire/release; the budget evicts (and disposes) only unpinned entries,
 * least-recently-used first, and leaves very recent entries alone so a
 * texture cannot be evicted between decode completion and delivery to its
 * first consumer. When everything is pinned the cache is allowed to run over
 * budget — correctness beats the cap.
 */
export class TextureLruCache<T extends DisposableTile> {
    private readonly entries = new Map<string, CacheEntry<T>>();
    private totalBytesInternal = 0;

    constructor(
        private budgetBytes: number,
        private readonly minResidencyMs = 10_000,
        private readonly now: () => number = Date.now,
    ) {}

    get size(): number {
        return this.entries.size;
    }

    get totalBytes(): number {
        return this.totalBytesInternal;
    }

    setBudgetBytes(bytes: number): void {
        this.budgetBytes = bytes;
        this.enforceBudget();
    }

    keys(): IterableIterator<string> {
        return this.entries.keys();
    }

    has(key: string): boolean {
        return this.entries.has(key);
    }

    get(key: string): T | undefined {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        entry.lastUse = this.now();
        return entry.tile;
    }

    set(key: string, tile: T, bytes: number): void {
        const existing = this.entries.get(key);
        if (existing) {
            this.totalBytesInternal -= existing.bytes;
            existing.tile.texture.dispose();
        }
        this.entries.set(key, { tile, bytes, refs: 0, lastUse: this.now() });
        this.totalBytesInternal += bytes;
        // The freshly inserted entry is about to be delivered to a consumer;
        // it must never be a casualty of its own insertion.
        this.enforceBudget(key);
    }

    /** Pin an entry against eviction (a consumer is showing it). */
    acquire(key: string): void {
        const entry = this.entries.get(key);
        if (!entry) return;
        entry.refs += 1;
        entry.lastUse = this.now();
    }

    /** Drop a pin; the entry becomes evictable once unpinned. */
    release(key: string): void {
        const entry = this.entries.get(key);
        if (!entry) return;
        entry.refs = Math.max(0, entry.refs - 1);
        entry.lastUse = this.now();
        this.enforceBudget();
    }

    /** Force-evict regardless of pins (explicit invalidation paths). */
    evict(key: string): boolean {
        const entry = this.entries.get(key);
        if (!entry) return false;
        this.totalBytesInternal -= entry.bytes;
        entry.tile.texture.dispose();
        this.entries.delete(key);
        return true;
    }

    /** Clear the cache, optionally without disposing (e.g. lost GL context). */
    clear(dispose = true): void {
        if (dispose) {
            for (const entry of this.entries.values()) {
                entry.tile.texture.dispose();
            }
        }
        this.entries.clear();
        this.totalBytesInternal = 0;
    }

    stats(): { entries: number; totalBytes: number; pinnedEntries: number } {
        let pinnedEntries = 0;
        for (const entry of this.entries.values()) {
            if (entry.refs > 0) pinnedEntries += 1;
        }
        return {
            entries: this.entries.size,
            totalBytes: this.totalBytesInternal,
            pinnedEntries,
        };
    }

    private enforceBudget(excludeKey?: string): void {
        if (this.totalBytesInternal <= this.budgetBytes) return;
        const cutoff = this.now() - this.minResidencyMs;
        const evictable = [...this.entries.entries()]
            .filter(
                ([key, entry]) =>
                    key !== excludeKey && entry.refs === 0 && entry.lastUse <= cutoff,
            )
            .sort(([, a], [, b]) => a.lastUse - b.lastUse);
        for (const [key] of evictable) {
            if (this.totalBytesInternal <= this.budgetBytes) return;
            this.evict(key);
        }
    }
}
