export interface BidderIndexPort {
    load(chainId: number): Promise<Set<string>>;
}
