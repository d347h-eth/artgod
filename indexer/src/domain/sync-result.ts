import { ChainSyncConflict, type SyncBlockHeader } from "./chain-sync.js";
import type { OnChainData } from "./onchain.js";
import { SYNC_FOLLOW_UP_KIND, type SyncFollowUp } from "./sync-follow-ups.js";

// Sparse historical input is allowed; adjacent supplied headers must belong to
// one chain. Repeated heights must describe the same immutable block metadata.
export function assertSyncBlockHeaders(
    blocks: readonly SyncBlockHeader[],
): void {
    const byNumber = new Map<number, SyncBlockHeader>();
    for (const block of blocks) {
        if (!Number.isSafeInteger(block.number) || block.number < 0) {
            throw new ChainSyncConflict(
                "Sync returned an invalid block number",
            );
        }
        const previous = byNumber.get(block.number);
        if (
            previous &&
            (previous.hash !== block.hash ||
                previous.parentHash !== block.parentHash ||
                previous.timestamp !== block.timestamp)
        ) {
            throw new ChainSyncConflict(
                `Sync returned conflicting headers for block ${block.number}`,
            );
        }
        byNumber.set(block.number, block);
    }
    for (const block of byNumber.values()) {
        const parent = byNumber.get(block.number - 1);
        if (parent && block.parentHash !== parent.hash) {
            throw new ChainSyncConflict(
                `Sync returned a broken parent link at block ${block.number}`,
            );
        }
    }
}

// Validate persisted facts and ephemeral fanout hints together. A reorg between
// log and header reads must reject the result before coverage or balances move.
export function assertSyncResultMatchesBlocks(input: {
    blocks: readonly SyncBlockHeader[];
    data: OnChainData;
}): void {
    assertSyncBlockHeaders(input.blocks);
    const byNumber = new Map(
        input.blocks.map((block) => [block.number, block]),
    );
    const groups = [
        input.data.transactions,
        ...Object.values(input.data.collectionScoped),
        ...Object.values(input.data.global),
    ];
    for (const group of groups) {
        for (const fact of group) {
            const block = byNumber.get(fact.blockNumber);
            if (!block || fact.blockHash !== block.hash) {
                throw new ChainSyncConflict(
                    `Sync fact does not match its header at block ${fact.blockNumber}`,
                );
            }
        }
    }
}

export function assertSyncFollowUpsMatchBlocks(input: {
    chainId: number;
    blocks: readonly SyncBlockHeader[];
    collectionIds: readonly number[];
    followUps: readonly SyncFollowUp[];
}): void {
    const headers = new Map(
        input.blocks.map((block) => [block.number, block.hash]),
    );
    const collections = new Set(input.collectionIds);
    for (const followUp of input.followUps) {
        if (
            followUp.job.chainId !== input.chainId ||
            (followUp.job.collectionId !== undefined &&
                !collections.has(followUp.job.collectionId))
        )
            throw new ChainSyncConflict(
                "Sync follow-up has a different acquisition scope",
            );
        if (
            followUp.kind === SYNC_FOLLOW_UP_KIND.Event &&
            (followUp.block.chainId !== input.chainId ||
                headers.get(followUp.block.blockNumber) !==
                    followUp.block.blockHash)
        )
            throw new ChainSyncConflict(
                "Sync follow-up does not match its canonical header",
            );
    }
}
