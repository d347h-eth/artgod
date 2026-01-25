export const OFFCHAIN_JOB_KIND = {
    OrderRaw: "offchain.order.raw",
} as const;

export type OffchainOrderRawPayload = {
    source: string;
    chainId: number;
    receivedAt: number;
    payload: unknown;
};
