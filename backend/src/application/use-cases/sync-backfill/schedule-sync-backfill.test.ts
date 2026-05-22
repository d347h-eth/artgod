import { describe, expect, it } from "vitest";
import type { ChainRecord } from "@artgod/shared/types/browse";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import { ScheduleSyncBackfillUseCase } from "./schedule-sync-backfill.js";
import type { SyncBackfillRangeCommand } from "./schedule-sync-backfill.js";
import type { SyncBackfillReadPort } from "./get-sync-backfill-state.js";

const CHAIN: ChainRecord = {
    id: 1,
    type: "evm",
    publicChainId: 1,
    slug: "ethereum",
    name: "Ethereum",
};

describe("ScheduleSyncBackfillUseCase", () => {
    it("splits manual chain-wide backfill into configured batches", async () => {
        const published: SyncBackfillRangeCommand[] = [];
        const useCase = new ScheduleSyncBackfillUseCase(
            1,
            3,
            chainResolver(),
            readPort(),
            {
                async publishBackfillRanges(commands) {
                    published.push(...commands);
                },
            },
        );

        const output = await useCase.scheduleBackfill({
            chainRef: "ethereum",
            collectionRef: "any",
            fromBlock: 2,
            toBlock: 8,
        });

        expect(output.queuedJobs).toBe(3);
        expect(output.collection).toBeNull();
        expect(published).toEqual([
            { chainId: 1, collectionId: null, fromBlock: 2, toBlock: 4 },
            { chainId: 1, collectionId: null, fromBlock: 5, toBlock: 7 },
            { chainId: 1, collectionId: null, fromBlock: 8, toBlock: 8 },
        ]);
    });

    it("pins manual backfill to the selected live collection", async () => {
        const published: SyncBackfillRangeCommand[] = [];
        const useCase = new ScheduleSyncBackfillUseCase(
            1,
            50,
            chainResolver(),
            readPort(),
            {
                async publishBackfillRanges(commands) {
                    published.push(...commands);
                },
            },
        );

        const output = await useCase.scheduleBackfill({
            chainRef: "ethereum",
            collectionRef: "terraforms",
            fromBlock: 10,
            toBlock: 11,
        });

        expect(output.collection).toEqual({
            collectionId: 7,
            slug: "terraforms",
        });
        expect(published).toEqual([
            { chainId: 1, collectionId: 7, fromBlock: 10, toBlock: 11 },
        ]);
    });
});

function chainResolver() {
    return {
        resolveChainRef() {
            return CHAIN;
        },
    };
}

function readPort(): Pick<SyncBackfillReadPort, "listBlockspaceCollections"> {
    return {
        listBlockspaceCollections() {
            return [
                {
                    chainId: 1,
                    collectionId: 7,
                    slug: "terraforms",
                    address: "0x1111111111111111111111111111111111111111",
                    status: COLLECTION_STATUS.Live,
                    deploymentBlock: null,
                    bootstrapAnchorBlock: 1,
                    bootstrapLastSyncedBlock: null,
                },
            ];
        },
    };
}
