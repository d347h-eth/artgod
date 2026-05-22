import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { db, setDbPath } from "@artgod/shared/database";
import { COLLECTION_STATUS, type CollectionStatus } from "@artgod/shared/types";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import { SqliteCollectionRegistry } from "../src/infra/collections/sqlite.js";

describe("collection scope resolver", () => {
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
                "DELETE FROM collection_scope_tokens;",
                "DELETE FROM collections;",
            ].join("\n"),
        );
    });

    it("resolves token ids and range splits against the current collection subset", () => {
        const chainId = 1;
        const contract = "0xabc0000000000000000000000000000000000000";
        const rangeA = insertCollection({
            chainId,
            slug: "range-a",
            address: contract,
            tokenScopeKind: "token_range",
            scopeStartTokenId: "1",
            scopeTotalSupply: 10,
        });
        const rangeB = insertCollection({
            chainId,
            slug: "range-b",
            address: contract,
            tokenScopeKind: "token_range",
            scopeStartTokenId: "11",
            scopeTotalSupply: 10,
        });
        const explicit = insertCollection({
            chainId,
            slug: "explicit",
            address: contract,
            tokenScopeKind: "explicit_token_ids",
            scopeStartTokenId: null,
            scopeTotalSupply: null,
        });
        insertScopeToken(chainId, explicit, "30");
        insertScopeToken(chainId, explicit, "35");

        const registry = new SqliteCollectionRegistry();
        const collections = registry.listCollectionsForSync(
            chainId,
            "backfill",
        );

        expect(
            registry.resolveTokenScopedCollectionId(
                chainId,
                collections,
                contract,
                "5",
            ),
        ).toBe(rangeA);
        expect(
            registry.resolveTokenScopedCollectionId(
                chainId,
                collections,
                contract,
                "12",
            ),
        ).toBe(rangeB);
        expect(
            registry.resolveTokenScopedCollectionId(
                chainId,
                collections,
                contract,
                "35",
            ),
        ).toBe(explicit);

        expect(
            registry.resolveTokenScopedCollectionId(
                chainId,
                [collections.find((collection) => collection.id === rangeA)!],
                contract,
                "12",
            ),
        ).toBeNull();

        expect(
            registry.splitRangeByCollectionScope(
                chainId,
                collections,
                contract,
                "5",
                "12",
            ),
        ).toEqual([
            {
                collectionId: rangeA,
                fromTokenId: "5",
                toTokenId: "10",
            },
            {
                collectionId: rangeB,
                fromTokenId: "11",
                toTokenId: "12",
            },
        ]);

        expect(
            registry.splitRangeByCollectionScope(
                chainId,
                collections,
                contract,
                "29",
                "35",
            ),
        ).toEqual([
            {
                collectionId: explicit,
                fromTokenId: "30",
                toTokenId: "30",
            },
            {
                collectionId: explicit,
                fromTokenId: "35",
                toTokenId: "35",
            },
        ]);
    });

    it("selects live and anchored bootstrapping collections for realtime sync", () => {
        const chainId = 1;
        const contract = "0xabc0000000000000000000000000000000000000";
        const live = insertCollection({
            chainId,
            slug: "live",
            address: contract,
            tokenScopeKind: "contract_all_tokens",
            scopeStartTokenId: null,
            scopeTotalSupply: null,
            status: COLLECTION_STATUS.Live,
        });
        const bootstrapping = insertCollection({
            chainId,
            slug: "bootstrapping",
            address: contract,
            tokenScopeKind: "contract_all_tokens",
            scopeStartTokenId: null,
            scopeTotalSupply: null,
            status: COLLECTION_STATUS.Bootstrapping,
            bootstrapAnchorBlock: 100,
        });
        insertCollection({
            chainId,
            slug: "unanchored",
            address: contract,
            tokenScopeKind: "contract_all_tokens",
            scopeStartTokenId: null,
            scopeTotalSupply: null,
            status: COLLECTION_STATUS.Bootstrapping,
        });
        insertCollection({
            chainId,
            slug: "paused",
            address: contract,
            tokenScopeKind: "contract_all_tokens",
            scopeStartTokenId: null,
            scopeTotalSupply: null,
            status: COLLECTION_STATUS.Paused,
        });

        const registry = new SqliteCollectionRegistry();
        const collectionIds = registry
            .listCollectionsForSync(chainId, "realtime")
            .map((collection) => collection.id)
            .sort((a, b) => a - b);

        expect(collectionIds).toEqual(
            [live, bootstrapping].sort((a, b) => a - b),
        );
    });
});

function insertCollection(input: {
    chainId: number;
    slug: string;
    address: string;
    tokenScopeKind: string;
    scopeStartTokenId: string | null;
    scopeTotalSupply: number | null;
    status?: CollectionStatus;
    bootstrapAnchorBlock?: number | null;
}): number {
    const result = db
        .prepare<{
            chainId: number;
            slug: string;
            address: string;
            status: string;
            tokenScopeKind: string;
            scopeStartTokenId: string | null;
            scopeTotalSupply: number | null;
            bootstrapAnchorBlock: number | null;
        }>(
            "INSERT INTO collections " +
                "(chain_id, slug, address, standard, status, token_scope_kind, scope_start_token_id, scope_total_supply, bootstrap_anchor_block) " +
                "VALUES (@chainId, @slug, @address, 'erc721', @status, @tokenScopeKind, @scopeStartTokenId, @scopeTotalSupply, @bootstrapAnchorBlock)",
        )
        .run({
            chainId: input.chainId,
            slug: input.slug,
            address: input.address.toLowerCase(),
            status: input.status ?? COLLECTION_STATUS.Live,
            tokenScopeKind: input.tokenScopeKind,
            scopeStartTokenId: input.scopeStartTokenId,
            scopeTotalSupply: input.scopeTotalSupply,
            bootstrapAnchorBlock: input.bootstrapAnchorBlock ?? null,
        });

    return Number(result.lastInsertRowid);
}

function insertScopeToken(
    chainId: number,
    collectionId: number,
    tokenId: string,
): void {
    db.prepare<[number, number, string]>(
        "INSERT INTO collection_scope_tokens (chain_id, collection_id, token_id) VALUES (?, ?, ?)",
    ).run(chainId, collectionId, tokenId);
}
