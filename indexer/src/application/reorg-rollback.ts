import type { ChainSyncCheckpoint } from "../domain/chain-sync.js";
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
    prepareRollback(input: {
        chainId: number;
        fromBlock: number;
    }): ReorgRollbackPlan;
    // Atomically validate the plan, restore ownership, remove orphaned facts and
    // coverage, and advance the chain revision. Failed validation writes nothing.
    rollbackFromBlock(input: {
        plan: ReorgRollbackPlan;
        snapshot: Erc721RollbackSnapshot;
    }): void;
}

export interface Erc721RollbackSnapshotPort {
    // Unknown RPC failures must reject; null means proven token absence.
    readSnapshot(input: {
        blockNumber: number;
        tokens: readonly Erc721TokenReference[];
    }): Promise<Erc721RollbackSnapshot>;
}

export class RollbackChainRange {
    constructor(
        private readonly storage: ReorgRollbackStore,
        private readonly ownership: Erc721RollbackSnapshotPort,
    ) {}

    async execute(input: {
        chainId: number;
        fromBlock: number;
    }): Promise<void> {
        const plan = this.storage.prepareRollback(input);
        const snapshot = await this.ownership.readSnapshot({
            blockNumber: input.fromBlock - 1,
            tokens: plan.tokens,
        });
        this.storage.rollbackFromBlock({ plan, snapshot });
    }
}
