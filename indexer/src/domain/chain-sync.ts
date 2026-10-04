// Capture before RPC work; rollback advances the revision in its write transaction.
export type ChainSyncCheckpoint = { chainId: number; revision: number };

export type SyncBlockHeader = {
    number: number;
    hash: string;
    parentHash: string;
    timestamp: number;
};

export class ChainSyncConflict extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ChainSyncConflict";
    }
}
