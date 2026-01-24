import type { BidderIndexPort } from "../ports/bidder-index.js";

export type BidderIndexState = {
    ready: boolean;
    size: number;
    lastRefreshAt: number | null;
};

export class BidderIndex {
    private makers = new Set<string>();
    private ready = false;
    private lastRefreshAt: number | null = null;

    constructor(
        private source: BidderIndexPort,
        private chainId: number,
    ) {}

    async refresh(): Promise<BidderIndexState> {
        const makers = await this.source.load(this.chainId);
        this.makers = makers;
        this.ready = true;
        this.lastRefreshAt = Date.now();
        return this.getState();
    }

    // Quiet default: do not emit triggers until the index has loaded and is non-empty.
    shouldEmit(maker: string): boolean {
        if (!this.ready) return false;
        if (this.makers.size === 0) return false;
        return this.makers.has(maker.toLowerCase());
    }

    isActive(): boolean {
        return this.ready && this.makers.size > 0;
    }

    getState(): BidderIndexState {
        return {
            ready: this.ready,
            size: this.makers.size,
            lastRefreshAt: this.lastRefreshAt,
        };
    }
}
