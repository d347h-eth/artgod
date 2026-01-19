export const ACTIVITY_KIND = {
    Transfer: "transfer",
    Fill: "fill",
} as const;

export type ActivityKind = (typeof ACTIVITY_KIND)[keyof typeof ACTIVITY_KIND];

export type ActivityRecord = {
    chainId: number;
    kind: ActivityKind;
    contract: string;
    tokenId: string;
    from?: string | null;
    to?: string | null;
    amount?: string | null;
    blockNumber: number;
    txHash: string;
    logIndex: number;
};
