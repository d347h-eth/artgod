import type { RpcBlock } from "../../src/ports/rpc.js";

export function syncBlockFixture(number: number): RpcBlock {
    return {
        number,
        hash: `0x${String(number).padStart(64, "0")}`,
        parentHash: `0x${String(Math.max(0, number - 1)).padStart(64, "0")}`,
        timestamp: number,
        transactions: [],
    };
}

// Ordinary storage fixtures represent already-confirmed canonical history.
export const FINALIZED_SYNC_CHECK_POLICY = {
    observedHeadBlock: Number.MAX_SAFE_INTEGER,
    reorgDepth: 32,
};
