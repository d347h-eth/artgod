import { beforeAll, describe, expect, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { COLLECTION_STANDARD, COLLECTION_STATUS } from "@artgod/shared/types";
import { TOKEN_ATTRIBUTE_SOURCE_KIND } from "@artgod/shared/types/token-attributes";
import { TOKEN_SET_SCHEMA_KIND } from "@artgod/shared/types/token-sets";
import captured from "./fixtures/cambria-charter-1997-metadata.json" with { type: "json" };
import { METADATA_STATS_RECOMPUTE_REASON } from "../src/domain/domain-jobs.js";
import { CollectionTokenScope } from "../src/domain/collections.js";
import { SqliteTokenAttributeWriter } from "../src/infra/attributes/sqlite-token-attributes.js";
import { SqliteMetadataDomain } from "../src/infra/domain/metadata.js";
import { SqliteMetadataStatsDomain } from "../src/infra/domain/metadata-stats.js";
import { HttpMetadataFetcher } from "../src/infra/metadata/http-fetcher.js";
import type { TokenSetRequest } from "../src/ports/token-sets.js";
import { SqliteTokenSetRegistry } from "../src/infra/token-sets/sqlite.js";
import { generateMerkleRoot } from "../src/application/token-sets/utils.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

const CHAIN_ID = 1;
let collectionId = 0;
const TOKEN_ID = "1997";
const CONTRACT = "0xabc0000000000000000000000000000000000000";
const EXTENSION_KEY = "metadata-refresh-fixture";
const EXTENSION_TRAIT = { key: "Fixture annotation", value: "retained" };

describe("metadata with multiple values per trait", () => {
    loadTestEnv();

    beforeAll(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });

    it("recovers missing traits, deduplicates exact pairs and preserves refreshed membership and counts", async () => {
        const scope = CollectionTokenScope.allContractTokens().toPersistence();
        const inserted = db
            .prepare(
                "INSERT INTO collections (chain_id,slug,address,standard,status,token_scope_kind) VALUES (?,?,?,?,?,?)",
            )
            .run(
                CHAIN_ID,
                "metadata-refresh-fixture",
                CONTRACT,
                COLLECTION_STANDARD.Erc721,
                COLLECTION_STATUS.Live,
                scope.tokenScopeKind,
            );
        collectionId = Number(inserted.lastInsertRowid);
        let document: Record<string, unknown> = { ...captured, attributes: [] };
        const domain = new SqliteMetadataDomain(
            {
                resolveTokenUri: async () =>
                    `data:application/json,${encodeURIComponent(JSON.stringify(document))}`,
            },
            new HttpMetadataFetcher(),
            { persistRawDebugPayloads: false },
        );
        const refresh = () =>
            domain.handleMetadataRefresh({
                chainId: CHAIN_ID,
                collectionId: collectionId,
                tokenId: TOKEN_ID,
                reason: METADATA_STATS_RECOMPUTE_REASON.MetadataRefresh,
            });
        // Replay an existing token whose prior refresh left no canonical traits.
        await refresh();
        new SqliteTokenAttributeWriter().replaceTokenAttributes({
            chainId: CHAIN_ID,
            collectionId: collectionId,
            contractAddress: CONTRACT,
            tokenId: TOKEN_ID,
            sourceKind: TOKEN_ATTRIBUTE_SOURCE_KIND.CollectionExtension,
            sourceKey: EXTENSION_KEY,
            attributes: [EXTENSION_TRAIT],
        });
        const registry = new SqliteTokenSetRegistry();
        const request: TokenSetRequest = {
            chainId: CHAIN_ID,
            collectionId: collectionId,
            schema: {
                kind: TOKEN_SET_SCHEMA_KIND.Attribute,
                data: {
                    collection: CONTRACT,
                    attributes: [
                        { key: "Affinity", value: "Delver" },
                        { key: "Affinities", value: "4" },
                        { key: "Top Affinity Score", min: 60, max: 99 },
                    ],
                },
            },
        };
        expect(registry.ensureTokenSet(request)).toBeNull();
        const repeated = captured.attributes.find(
            (attribute) => attribute.trait_type === "Affinity",
        )!;
        document = {
            ...captured,
            attributes: [...captured.attributes, repeated],
        };
        await refresh();
        await refresh();
        const traits = selectTraits();
        expect(traits).toHaveLength(12);
        for (const attribute of captured.attributes) {
            expect(traits).toContainEqual({
                key: attribute.trait_type,
                value: String(attribute.value),
            });
        }
        expect(selectExtensionTraits()).toEqual([EXTENSION_TRAIT]);
        expect(
            db
                .prepare(
                    "SELECT uri,raw_json,attributes_json FROM token_metadata WHERE collection_id=? AND token_id=?",
                )
                .get(collectionId, TOKEN_ID),
        ).toEqual({ uri: null, raw_json: null, attributes_json: null });
        const resolved = registry.ensureTokenSet(request);
        expect(resolved?.merkleRoot).toBe(generateMerkleRoot([TOKEN_ID]));
        expect(resolved?.tokenCount).toBe(1);

        const stats = new SqliteMetadataStatsDomain();
        await stats.handleRecompute({
            chainId: CHAIN_ID,
            collectionId: collectionId,
            reason: METADATA_STATS_RECOMPUTE_REASON.MetadataRefresh,
        });
        const affinityCounts = db
            .prepare(
                "SELECT a.value,s.token_count FROM collection_trait_stats s JOIN attributes a ON a.id=s.attribute_id JOIN attribute_keys k ON k.id=a.attribute_key_id WHERE s.collection_id=? AND k.key=? ORDER BY a.value",
            )
            .all(collectionId, "Affinity");
        expect(affinityCounts).toEqual([
            { value: "Delver", token_count: 1 },
            { value: "Forager", token_count: 1 },
            { value: "Prospector", token_count: 1 },
            { value: "Pugilist", token_count: 1 },
        ]);

        document = {
            ...captured,
            attributes: captured.attributes
                .filter(
                    (attribute) =>
                        !(
                            attribute.trait_type === "Affinity" &&
                            attribute.value === "Forager"
                        ),
                )
                .map((attribute) =>
                    attribute.trait_type === "Top Affinity Score"
                        ? { ...attribute, value: 58 }
                        : attribute,
                ),
        };
        await refresh();
        expect(selectTraits()).toHaveLength(11);
        expect(selectTraits()).not.toContainEqual({
            key: "Affinity",
            value: "Forager",
        });
        expect(selectExtensionTraits()).toEqual([EXTENSION_TRAIT]);
        // Fresh materialization uses the refreshed numeric value, not the prior match.
        expect(registry.ensureTokenSet(request)).toBeNull();
        await stats.handleRecompute({
            chainId: CHAIN_ID,
            collectionId: collectionId,
            reason: METADATA_STATS_RECOMPUTE_REASON.MetadataRefresh,
        });
        expect(
            db
                .prepare(
                    "SELECT s.token_count FROM collection_trait_stats s JOIN attributes a ON a.id=s.attribute_id JOIN attribute_keys k ON k.id=a.attribute_key_id WHERE s.collection_id=? AND k.key=? AND a.value=?",
                )
                .get(collectionId, "Affinity", "Forager"),
        ).toBeUndefined();
    });
});

function selectTraits(): Array<{ key: string; value: string }> {
    return selectSourceTraits(TOKEN_ATTRIBUTE_SOURCE_KIND.Metadata);
}

function selectExtensionTraits(): Array<{ key: string; value: string }> {
    return selectSourceTraits(TOKEN_ATTRIBUTE_SOURCE_KIND.CollectionExtension);
}

function selectSourceTraits(
    source: string,
): Array<{ key: string; value: string }> {
    return db
        .prepare(
            "SELECT k.key,a.value FROM token_attributes ta JOIN attributes a ON a.id=ta.attribute_id JOIN attribute_keys k ON k.id=a.attribute_key_id WHERE ta.collection_id=? AND ta.token_id=? AND ta.source_kind=? ORDER BY k.key,a.value",
        )
        .all(collectionId, TOKEN_ID, source) as Array<{
        key: string;
        value: string;
    }>;
}
