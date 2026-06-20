import { describe, expect, it } from "vitest";
import type {
    ChainRecord,
    CollectionListItem,
} from "@artgod/shared/types/browse";
import { PurgeCollectionUseCase } from "./purge-collection.js";

describe("PurgeCollectionUseCase", () => {
    it("cleans collection image cache after the database purge commits", async () => {
        const calls: string[] = [];
        const chain: ChainRecord = {
            id: 1,
            type: "evm",
            publicChainId: 1,
            slug: "ethereum",
            name: "Ethereum",
        };
        const collection: CollectionListItem = {
            chainId: 1,
            collectionId: 7,
            slug: "target",
            address: "0x1111111111111111111111111111111111111111",
            standard: "erc721",
            status: "live",
            deploymentBlock: null,
            bootstrapAnchorBlock: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
        };
        const useCase = new PurgeCollectionUseCase(
            1,
            {
                resolveChainRef() {
                    return chain;
                },
            },
            {
                resolveCollectionRef() {
                    return collection;
                },
            },
            {
                purgeCollectionData(input) {
                    calls.push(`db:${input.chainId}:${input.collectionId}`);
                    return [{ table: "collections", rowCount: 1 }];
                },
            },
            {
                async deleteCollectionImageCacheDirectory(input) {
                    calls.push(`files:${input.chainId}:${input.collectionId}`);
                },
            },
        );

        const result = await useCase.purgeCollection({
            chainRef: "ethereum",
            collectionRef: "target",
            confirmation: "purge",
        });

        expect(result.totalDeletedRows).toBe(1);
        expect(calls).toEqual(["db:1:7", "files:1:7"]);
    });
});
