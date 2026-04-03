import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { db, setDbPath } from "@artgod/shared/database";
import { DOMAIN_SYNC_PROJECTION } from "../src/domain/domain-jobs.js";
import type { TokenMetadata } from "../src/domain/metadata.js";
import { SqliteMetadataDomain } from "../src/infra/domain/metadata.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

describe("metadata domain anchor gating", () => {
    loadTestEnv();

    beforeAll(async () => {
        const dbPath = await createTempDbPath();
        setDbPath(dbPath);
        const migrations = createMigrationRunner();
        await migrations.runMigrations();
    });

    beforeEach(() => {
        db.exec(
            [
                "DELETE FROM collection_trait_stats;",
                "DELETE FROM token_attributes;",
                "DELETE FROM attributes;",
                "DELETE FROM attribute_keys;",
                "DELETE FROM token_metadata;",
                "DELETE FROM tokens;",
                "DELETE FROM nft_transfer_events;",
                "DELETE FROM collections;",
            ].join("\n"),
        );
    });

    it("syncs metadata only from transfers after the bootstrap anchor", async () => {
        const chainId = 1;
        const contract = "0xabc0000000000000000000000000000000000000";
        const collectionId = insertCollection({
            chainId,
            collectionId: 1,
            slug: "terraforms",
            address: contract,
            anchorBlock: 100,
        });
        insertTransfer({
            chainId,
            collectionId,
            contract,
            tokenId: "1",
            blockNumber: 99,
        });
        insertTransfer({
            chainId,
            collectionId,
            contract,
            tokenId: "2",
            blockNumber: 101,
        });

        const resolvedTokenIds: string[] = [];
        const domain = new SqliteMetadataDomain(
            {
                resolveTokenUri: async (_contract, tokenId) => {
                    resolvedTokenIds.push(tokenId);
                    return `https://example.com/${tokenId}`;
                },
            },
            {
                fetchMetadata: async (uri) => buildMetadata(uri),
            },
        );

        const result = await domain.handleDomainSync({
            chainId,
            collectionId: null,
            fromBlock: 99,
            toBlock: 101,
            mode: "backfill",
            projection: DOMAIN_SYNC_PROJECTION.CurrentState,
            sourceJobId: "sync:backfill:test",
            sourceKind: "sync.backfill.range",
        });

        expect(resolvedTokenIds).toEqual(["2"]);
        expect(result.updatedTokens).toEqual([
            {
                collectionId,
                contract,
                tokenId: "2",
            },
        ]);
        expect(selectMetadataTokenIds(chainId, collectionId)).toEqual(["2"]);
    });

    it("skips metadata sync entirely for facts-only projection", async () => {
        const chainId = 1;
        const contract = "0xabc0000000000000000000000000000000000000";
        const collectionId = insertCollection({
            chainId,
            collectionId: 1,
            slug: "terraforms",
            address: contract,
            anchorBlock: 100,
        });
        insertTransfer({
            chainId,
            collectionId,
            contract,
            tokenId: "2",
            blockNumber: 101,
        });

        const domain = new SqliteMetadataDomain(
            {
                resolveTokenUri: async () => {
                    throw new Error("resolver should not run for facts-only");
                },
            },
            {
                fetchMetadata: async () => {
                    throw new Error("fetcher should not run for facts-only");
                },
            },
        );

        const result = await domain.handleDomainSync({
            chainId,
            collectionId: null,
            fromBlock: 101,
            toBlock: 101,
            mode: "backfill",
            projection: DOMAIN_SYNC_PROJECTION.FactsOnly,
            sourceJobId: "sync:backfill:test",
            sourceKind: "sync.backfill.range",
        });

        expect(result).toEqual({
            contracts: [],
            updatedTokens: [],
        });
        expect(selectMetadataTokenIds(chainId, collectionId)).toEqual([]);
    });
});

function insertCollection(input: {
    chainId: number;
    collectionId: number;
    slug: string;
    address: string;
    anchorBlock: number;
}): number {
    db.prepare<[number, number, string, string, number]>(
        "INSERT INTO collections " +
            "(chain_id, collection_id, slug, address, standard, status, token_scope_kind, bootstrap_anchor_block) " +
            "VALUES (?, ?, ?, ?, 'erc721', 'live', 'contract_all_tokens', ?)",
    ).run(
        input.chainId,
        input.collectionId,
        input.slug,
        input.address.toLowerCase(),
        input.anchorBlock,
    );

    return input.collectionId;
}

function insertTransfer(input: {
    chainId: number;
    collectionId: number;
    contract: string;
    tokenId: string;
    blockNumber: number;
}): void {
    db.prepare<
        [number, number, string, string, string, string, string, number, string, number, string, number, string]
    >(
        "INSERT INTO nft_transfer_events " +
            "(chain_id, collection_id, contract_address, from_address, to_address, token_id, amount, block_number, block_hash, block_timestamp, tx_hash, log_index, kind) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
        input.chainId,
        input.collectionId,
        input.contract.toLowerCase(),
        "0x1000000000000000000000000000000000000000",
        "0x2000000000000000000000000000000000000000",
        input.tokenId,
        "1",
        input.blockNumber,
        `0x${String(input.blockNumber).padStart(64, "0")}`,
        1_726_000_000 + input.blockNumber,
        `0x${String(input.blockNumber + 1000).padStart(64, "0")}`,
        input.blockNumber,
        "erc721",
    );
}

function buildMetadata(uri: string): TokenMetadata {
    return {
        uri,
        name: `Token ${uri.split("/").at(-1)}`,
        attributes: [],
        rawJson: JSON.stringify({ uri }),
    };
}

function selectMetadataTokenIds(
    chainId: number,
    collectionId: number,
): string[] {
    return (
        db.prepare<[number, number], { token_id: string }>(
            "SELECT token_id FROM token_metadata " +
                "WHERE chain_id = ? AND collection_id = ? " +
                "ORDER BY token_id ASC",
        ).all(chainId, collectionId) as Array<{ token_id: string }>
    ).map((row) => row.token_id);
}
