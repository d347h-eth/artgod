export const REORG_JOB_KIND = {
    BlockCheck: "reorg.block-check",
} as const;

export type BlockCheckPayload = {
    blockNumber: number;
};
