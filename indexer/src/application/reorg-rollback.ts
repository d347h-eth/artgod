import type {
    ChainSyncCheckpoint,
    VerifiedChainBlock,
} from "../domain/chain-sync.js";
import type { Erc721TokenReference } from "../domain/ownership.js";

export type ReorgRollbackPlan = {
    checkpoint: ChainSyncCheckpoint;
    fromBlock: number;
    // Only distinct tokens touched by the rollback window, not the collection inventory.
    tokens: Erc721TokenReference[];
};

export type Erc721RollbackSnapshot = {
    block: {
        blockNumber: number;
        blockHash: string;
        parentHash: string;
        blockTimestamp: number;
    };
    owners: (Erc721TokenReference & { owner: string | null })[];
};

export interface ReorgRollbackStore {
    // Refuse crossing retained bootstrap anchors before ownership RPC.
    prepareRollback(input: {
        chainId: number;
        fromBlock: number;
    }): ReorgRollbackPlan;
    // Atomically validate the plan, restore ownership, remove orphaned facts and
    // coverage, and advance the chain revision. Recheck bootstrap anchors in the
    // writer; failed validation writes nothing. Retain signed order declarations,
    // discard orphaned protocol results, and admit their validation in this same
    // transaction; source reconciliation is not a rollback dependency.
    rollbackFromBlock(input: {
        plan: ReorgRollbackPlan;
        snapshot: Erc721RollbackSnapshot;
    }): void;
}

export interface Erc721RollbackSnapshotPort {
    // Unknown RPC failures must reject; null means proven token absence.
    readSnapshot(input: {
        fork: VerifiedChainBlock;
        tokens: readonly Erc721TokenReference[];
    }): Promise<Erc721RollbackSnapshot>;
}

export class RollbackChainRange {
    constructor(
        private readonly storage: ReorgRollbackStore,
        private readonly ownership: Erc721RollbackSnapshotPort,
    ) {}

    // Preparing reads RPC without a writer; the caller chooses the atomic commit
    // boundary (plain rollback or rollback plus a durable recovery continuation).
    async prepare(fork: VerifiedChainBlock): Promise<{
        plan: ReorgRollbackPlan;
        snapshot: Erc721RollbackSnapshot;
    }> {
        const plan = this.storage.prepareRollback({
            chainId: fork.chainId,
            fromBlock: fork.number + 1,
        });
        const snapshot = await this.ownership.readSnapshot({
            fork,
            tokens: plan.tokens,
        });
        return { plan, snapshot };
    }

    async execute(fork: VerifiedChainBlock): Promise<void> {
        this.storage.rollbackFromBlock(await this.prepare(fork));
    }
}
