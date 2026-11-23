import { readViewStatus } from "@artgod/shared/read-models/trait-catalog";
import { zeroAddress, zeroHash } from "viem";
import { TOKEN_SET_SCHEMA_KIND } from "@artgod/shared/types/token-sets";
import { IMAGE_CACHE_MODE } from "@artgod/shared/media/token-image-cache";
import { createMetadataDomain } from "../src/runtime/create-metadata-domain.js";
import { HttpMetadataFetcher } from "../src/infra/metadata/http-fetcher.js";
import {
    DOMAIN_SYNC_PROJECTION,
    METADATA_REFRESH_REASON,
    METADATA_REFRESH_SOURCE,
} from "../src/domain/domain-jobs.js";
import { createMetadataPendingFollowups } from "../src/application/metadata/pending-followups.js";
import { SqliteMetadataRefreshFollowups } from "../src/infra/metadata/sqlite-refresh-followups.js";
import { SqliteQueueOutbox } from "../src/infra/queue/sqlite-queue-outbox.js";
import { SqliteTokenSetRegistry } from "../src/infra/token-sets/sqlite.js";
import { SqliteStorage } from "../src/infra/storage/sqlite.js";
import { commitRollbackFixture } from "./helpers/rollback-fixture.js";
import { beforeAll, beforeEach, describe, it, expect } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    getTraitCatalogRebuild,
    requestTraitCatalogRebuild,
} from "@artgod/shared/database/trait-catalog-rebuilds";
import { readCanonicalTokenTraits } from "@artgod/shared/database/canonical-traits";
import {
    NFT111K_MAINNET_CONTRACT_ADDRESS,
    NFT111K_METADATA,
    nft111kTraitCatalog,
} from "@artgod/shared/extensions/111k";
import {
    TRAIT_CATALOG_REBUILD_STATUS as STATUS,
    type TraitCatalogMapper,
} from "@artgod/shared/types/trait-catalog";
import type { TraitFilter } from "@artgod/shared/types/browse";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import { TOKEN_ATTRIBUTE_SOURCE_KIND } from "@artgod/shared/types/token-attributes";
import { SqliteCollectionPurgeRepository } from "../../backend/src/infra/collections/sqlite-collection-purge-repository.js";
import {
    advanceTraitCatalog,
    installedCatalogMapper,
} from "../src/application/collection-extensions/trait-catalog.js";
import { SqliteTraitCatalog } from "../src/infra/metadata/sqlite-trait-catalog.js";
import { SqliteMetadataStore } from "../src/infra/metadata/sqlite-metadata-store.js";
import { SqliteCollectionExtensions } from "../src/infra/collection-extensions/sqlite.js";
import { SqliteTokenAttributeWriter } from "../src/infra/attributes/sqlite-token-attributes.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import {
    NFT111K_TEST_OWNER,
    nft111kTestInstall,
} from "./fixtures/111k-bootstrap.js";

const install = nft111kTestInstall();
const { chainId, collectionId } = install;
const contract = NFT111K_MAINNET_CONTRACT_ADDRESS;
const debug = { persistRawDebugPayloads: false };
const driMi = [{ key: NFT111K_METADATA.CollectionBlock, value: "DriMi" }];
const view = nft111kTraitCatalog.classify(driMi);
const mapperVersion = nft111kTraitCatalog.availableVersion(view);
const request = { chainId, collectionId, viewId: view.id, mapperVersion };
let resolve: () => TraitCatalogMapper;
let catalog: SqliteTraitCatalog;
let metadata: SqliteMetadataStore;

function seedCollection() {
    db.prepare(
        "INSERT INTO collections(chain_id,collection_id,slug,address,standard,status,token_scope_kind) VALUES(?,?,?,?,'erc721',?,'contract_all_tokens')",
    ).run(
        chainId,
        collectionId,
        "test-catalog",
        contract,
        COLLECTION_STATUS.Live,
    );
    new SqliteCollectionExtensions(debug).upsertInstall(install);
}
function observe(
    tokenId: string,
    pairs: TraitFilter[],
    afterWrite?: () => void,
) {
    const attempt = metadata.begin(
        { chainId, collectionId, contract, tokenId, standard: "erc721" },
        {},
        1,
    )!;
    return metadata.complete(
        attempt,
        {
            uri: "test://debug-only",
            rawJson: "{}",
            attributes: pairs.map((pair) => ({
                traitType: pair.key,
                value: pair.value,
            })),
        },
        { ready: true },
        2,
        afterWrite,
    );
}
function drain() {
    for (let i = 0; i < 1000; i++)
        if (!advanceTraitCatalog(chainId, catalog, resolve)) return;
    throw new Error("Catalog failed to settle");
}
function published(): number {
    return (
        db
            .prepare(
                "SELECT active_generation FROM trait_catalog_views WHERE view_id=?",
            )
            .get(view.id) as { active_generation: number }
    ).active_generation;
}
function values(generation: number, tokenId: string) {
    return db
        .prepare(
            "SELECT field_id AS key,value FROM trait_catalog_values WHERE generation=? AND token_id=? ORDER BY field_id,value",
        )
        .all(generation, tokenId);
}

describe("local trait catalog lifecycle", () => {
    beforeAll(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });
    beforeEach(() => {
        db.exec(
            "DELETE FROM collection_extension_installs; DELETE FROM token_metadata; DELETE FROM tokens; DELETE FROM metadata_pending; DELETE FROM collections;",
        );
        seedCollection();
        const installed = installedCatalogMapper(
            new SqliteCollectionExtensions(debug),
        );
        resolve = () => installed(chainId, collectionId)!;
        catalog = new SqliteTraitCatalog(() => resolve());
        metadata = new SqliteMetadataStore(debug, catalog);
    });
    it("retains atomic source-owned projection work, replaces obsolete traits and rejects superseded leases", () => {
        const before = [
            ...driMi,
            { key: "a:b", value: "c" },
            { key: "a", value: "b:c" },
            { key: "a", value: "d" },
        ];
        observe("1", before);
        const old = catalog.claim(chainId, 10)!;
        expect(old.traits).toHaveLength(4);
        const later = catalog.claim(chainId, 1_000_000)!;
        catalog.finish(
            old,
            nft111kTraitCatalog.project(
                old.view,
                old.mapperVersion,
                old.traits,
            ),
        );
        expect(values(old.generation, "1")).toEqual([]);
        catalog.finish(
            later,
            nft111kTraitCatalog.project(
                later.view,
                later.mapperVersion,
                later.traits,
            ),
        );
        expect(values(old.generation, "1")).toHaveLength(4);

        const writer = new SqliteTokenAttributeWriter();
        writer.replaceTokenAttributes({
            chainId,
            collectionId,
            contractAddress: contract,
            tokenId: "1",
            sourceKind: TOKEN_ATTRIBUTE_SOURCE_KIND.CollectionExtension,
            sourceKey: "fixture",
            attributes: [{ key: "extra", value: "extension" }],
        });
        expect(readCanonicalTokenTraits(chainId, collectionId, "1")).toEqual(
            old.traits,
        );
        expect(() =>
            observe("1", [], () => {
                throw new Error("rollback");
            }),
        ).toThrow("rollback");
        expect(values(old.generation, "1")).toHaveLength(4);
        observe("1", driMi);
        const stale = catalog.claim(chainId, 10)!;
        const egg = [{ key: NFT111K_METADATA.Type, value: "egg" }];
        observe("1", egg);
        catalog.finish(
            stale,
            nft111kTraitCatalog.project(
                stale.view,
                stale.mapperVersion,
                stale.traits,
            ),
        );
        drain();
        expect(values(old.generation, "1")).toEqual([]);
        expect(
            db
                .prepare("SELECT view_id,revision FROM trait_catalog_members")
                .get(),
        ).toEqual({
            view_id: nft111kTraitCatalog.classify(egg).id,
            revision: stale.revision + 1,
        });
        expect(
            db
                .prepare(
                    "SELECT uri,attributes_json,raw_json FROM token_metadata",
                )
                .get(),
        ).toEqual({ uri: null, attributes_json: null, raw_json: null });
    });
    it.each([
        ["plane of existence", "Character 1 - Mini drif / 1body", "Characters"],
        ["backrooms 2", "Painting 1 Artist", "Paintings"],
    ])(
        "publishes the structured %s mapper over an existing identity generation",
        (block, key, group) => {
            const facts = [
                { key: NFT111K_METADATA.CollectionBlock, value: block },
                { key, value: "First" },
            ];
            const selected = nft111kTraitCatalog.classify(facts);
            // Simulate the earlier application version which knew only the universal identity mapping.
            resolve = () => ({
                ...nft111kTraitCatalog,
                availableVersion: () => mapperVersion,
            });
            observe("1", facts);
            drain();
            const before = db
                .prepare(
                    "SELECT active_generation AS generation FROM trait_catalog_views WHERE view_id=?",
                )
                .get(selected.id) as { generation: number };
            expect(values(before.generation, "1")).toContainEqual(facts[1]);
            resolve = () => nft111kTraitCatalog;
            const run = requestTraitCatalogRebuild({
                chainId,
                collectionId,
                viewId: selected.id,
                mapperVersion: nft111kTraitCatalog.availableVersion(selected),
            });
            drain();
            expect(
                getTraitCatalogRebuild(chainId, collectionId, run.runId)
                    ?.status,
            ).toBe(STATUS.Completed);
            const traits = readCanonicalTokenTraits(chainId, collectionId, "1");
            expect(traits).toHaveLength(2);
            expect(traits).toEqual(expect.arrayContaining(facts));
            expect(values(run.generation, "1")).toEqual([facts[0]]);
            const raw = db
                .prepare(
                    "SELECT tree_json FROM trait_catalog_projections WHERE generation=? AND token_id=?",
                )
                .get(run.generation, "1") as { tree_json: string };
            expect(JSON.parse(raw.tree_json)).toContainEqual(
                expect.objectContaining({ label: group }),
            );
        },
    );

    it("resumes generation enumeration and atomically publishes current members, including entries behind its cursor", () => {
        for (let i = 1; i <= 130; i++) observe(String(i), driMi);
        drain();
        const active = published();
        const run = requestTraitCatalogRebuild(request);
        expect(requestTraitCatalogRebuild(request).runId).toBe(run.runId);
        expect(catalog.advanceRebuild(chainId)).toBe(true);
        const inFlight = catalog.claim(chainId, 10)!;
        observe(inFlight.tokenId, [
            { key: NFT111K_METADATA.Type, value: "egg" },
        ]);
        observe("0", driMi);
        catalog.finish(
            inFlight,
            nft111kTraitCatalog.project(view, mapperVersion, driMi),
        );
        catalog = new SqliteTraitCatalog(resolve);
        expect(published()).toBe(active);
        drain();
        expect(
            getTraitCatalogRebuild(chainId, collectionId, run.runId),
        ).toMatchObject({
            status: STATUS.Completed,
            processed: 130,
            total: 130,
        });
        expect(published()).toBe(run.generation);
        expect(values(run.generation, inFlight.tokenId)).toEqual([]);
        expect(values(run.generation, "0")).toEqual(driMi);
        expect(values(active, "1")).toEqual([]);
    });
    it("retains accepted data when classification fails and retries failed rebuilds from saved source", () => {
        resolve = () => ({
            ...nft111kTraitCatalog,
            classify() {
                throw new Error("classifier unavailable");
            },
        });
        observe("1", driMi);
        expect(
            db
                .prepare(
                    "SELECT view_id,classification_error FROM trait_catalog_members",
                )
                .get(),
        ).toMatchObject({
            view_id: nft111kTraitCatalog.unclassified.id,
            classification_error: expect.stringContaining(
                "classifier unavailable",
            ),
        });
        expect(
            readViewStatus(
                chainId,
                collectionId,
                nft111kTraitCatalog,
                nft111kTraitCatalog.unclassified.id,
            )[0],
        ).toMatchObject({ classified: 1, ready: 0, failed: 1 });
        resolve = () => nft111kTraitCatalog;
        expect(catalog.retryClassification(chainId, Date.now() + 60_000)).toBe(
            true,
        );
        drain();
        const old = published();
        const run = requestTraitCatalogRebuild(request);
        resolve = () => ({
            ...nft111kTraitCatalog,
            project() {
                throw new Error("invalid mapping");
            },
        });
        drain();
        expect(
            getTraitCatalogRebuild(chainId, collectionId, run.runId)?.status,
        ).toBe(STATUS.Failed);
        expect(published()).toBe(old);
        // The failed run had already enumerated token 1. Token 0 enters behind that cursor.
        observe("0", driMi);
        drain();
        expect(
            readViewStatus(
                chainId,
                collectionId,
                nft111kTraitCatalog,
                view.id,
            )[0],
        ).toMatchObject({
            classified: 2,
            ready: 1,
            failed: 1,
            latestRun: { status: STATUS.Failed },
        });
        resolve = () => nft111kTraitCatalog;
        requestTraitCatalogRebuild({ ...request, retryRunId: run.runId });
        drain();
        expect(published()).toBe(run.generation);
        expect(values(run.generation, "1")).toEqual(driMi);
        expect(values(run.generation, "0")).toEqual(driMi);
    });
    it("does not publish a rebuild over missing normalized links", () => {
        observe("1", driMi);
        drain();
        const active = published();
        const run = requestTraitCatalogRebuild(request);
        db.prepare(
            "DELETE FROM token_attributes WHERE chain_id=? AND collection_id=? AND token_id=?",
        ).run(chainId, collectionId, "1");
        drain();
        expect(
            getTraitCatalogRebuild(chainId, collectionId, run.runId),
        ).toMatchObject({
            status: STATUS.Failed,
            error: expect.stringContaining("canonical trait links"),
        });
        expect(published()).toBe(active);
    });
    it("fences removed observations on rollback and a reused collection ID after purge", () => {
        observe("1", driMi);
        const first = catalog.claim(chainId, 10)!;
        db.prepare(
            "UPDATE token_metadata SET block_number=? WHERE token_id=?",
        ).run(102, "1");
        commitRollbackFixture({
            storage: new SqliteStorage(),
            chainId,
            fromBlock: 102,
            owners: [],
        });
        expect(readCanonicalTokenTraits(chainId, collectionId, "1")).toEqual(
            [],
        );
        observe("1", driMi);
        const second = catalog.claim(chainId, 10)!;
        expect(second.revision).toBeGreaterThan(first.revision);
        catalog.finish(
            first,
            nft111kTraitCatalog.project(view, mapperVersion, driMi),
        );
        expect(values(first.generation, "1")).toEqual([]);
        requestTraitCatalogRebuild(request);
        new SqliteCollectionPurgeRepository().purgeCollectionData({
            chainId,
            collectionId,
        });
        seedCollection();
        observe("1", driMi);
        catalog.finish(
            second,
            nft111kTraitCatalog.project(view, mapperVersion, driMi),
        );
        drain();
        expect(published()).toBeGreaterThan(second.generation);
        expect(values(published(), "1")).toEqual(driMi);
    });
    it("projects bootstrap eggs, a pending hatch and a later mint through the runtime factory without refreshing source during rebuild", async () => {
        db.prepare(
            "UPDATE collections SET bootstrap_anchor_block=100 WHERE collection_id=?",
        ).run(collectionId);
        const documents = new Map<string, Record<string, unknown>>();
        let reads = 0;
        const domain = createMetadataDomain(
            {
                resolveTokenUri: async (_contract, tokenId) => {
                    reads++;
                    const doc = documents.get(tokenId);
                    return doc
                        ? "data:application/json," +
                              encodeURIComponent(JSON.stringify(doc))
                        : null;
                },
            },
            new HttpMetadataFetcher(),
            debug,
        );
        const bootstrap = {
            chainId,
            collectionId,
            tokenId: "81",
            blockNumber: 100,
            blockHash: zeroHash,
            reason: METADATA_REFRESH_REASON.BootstrapSnapshot,
            source: METADATA_REFRESH_SOURCE.Bootstrap,
        };
        documents.set("81", {
            image: "ipfs://fixture-egg",
            category: "egg",
            attributes: [{ trait_type: NFT111K_METADATA.Type, value: "egg" }],
        });
        expect(await domain.handleMetadataRefresh(bootstrap)).toMatchObject({
            tokenId: "81",
        });
        drain();
        const membership = (tokenId: string) =>
            db
                .prepare(
                    "SELECT m.view_id AS viewId,m.revision,v.active_generation AS generation FROM trait_catalog_members m JOIN trait_catalog_views v USING(chain_id,collection_id,view_id) WHERE m.chain_id=? AND m.collection_id=? AND m.token_id=?",
                )
                .get(chainId, collectionId, tokenId) as {
                viewId: string;
                revision: number;
                generation: number;
            };
        const egg = membership("81");
        expect(values(egg.generation, "81")).toEqual([
            { key: NFT111K_METADATA.Type, value: "egg" },
        ]);

        db.prepare(
            "INSERT INTO nft_balances(chain_id,collection_id,contract_address,token_id,owner,amount,last_block_number,last_block_hash,last_block_timestamp,last_tx_hash,last_log_index) VALUES(?,?,?,'81',?,'1',101,?,1,?,0)",
        ).run(
            chainId,
            collectionId,
            contract,
            NFT111K_TEST_OWNER,
            zeroHash,
            zeroHash,
        );
        documents.delete("81");
        expect(
            await domain.handleMetadataRefresh({
                ...bootstrap,
                reason: METADATA_REFRESH_REASON.Pending,
                source: METADATA_REFRESH_SOURCE.Onchain,
            }),
        ).toBeNull();
        expect(membership("81")).toEqual(egg);
        db.prepare(
            "UPDATE metadata_pending SET due_at=0 WHERE collection_id=? AND token_id='81'",
        ).run(collectionId);
        documents.set("81", {
            image: "ipfs://fixture-reveal",
            attributes: [
                {
                    trait_type: NFT111K_METADATA.CollectionBlock,
                    value: "backrooms 2",
                },
                { trait_type: "Painting 1", value: "Example" },
                { trait_type: "Painting 1 Artist", value: "Example artist" },
            ],
        });
        const outbox = new SqliteQueueOutbox();
        const retain = createMetadataPendingFollowups({
            chainId,
            followups: new SqliteMetadataRefreshFollowups(outbox),
            extensions: new SqliteCollectionExtensions(debug),
            imagePolicy: {
                getImageCachePolicyConfig: () => ({
                    imageCacheMode: IMAGE_CACHE_MODE.RefreshOnMetadata,
                    maxDimension: null,
                }),
            },
            outbox,
        });
        expect(await domain.retryPending(chainId, retain)).toBeTruthy();
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) n FROM metadata_refresh_extension_artifact_tasks WHERE collection_id=? AND token_id='81'",
                )
                .get(collectionId),
        ).toEqual({ n: 1 });
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) n FROM queue_outbox WHERE chain_id=? AND collection_id=?",
                )
                .get(chainId, collectionId),
        ).toEqual({ n: 2 });
        const hatched = membership("81");
        expect(hatched.viewId).not.toBe(egg.viewId);
        expect(hatched.revision).toBeGreaterThan(egg.revision);
        expect(values(egg.generation, "81")).toEqual([]);
        expect(values(hatched.generation, "81")).toEqual([]);
        drain();
        expect(values(hatched.generation, "81")).not.toContainEqual({
            key: "Painting 1 Artist",
            value: "Example artist",
        });
        const sets = new SqliteTokenSetRegistry();
        const by = (key: string, value: string) =>
            sets.ensureTokenSet({
                chainId,
                collectionId,
                schema: {
                    kind: TOKEN_SET_SCHEMA_KIND.Attribute,
                    data: {
                        collection: contract,
                        attributes: [{ key, value }],
                    },
                },
            });
        const native = by("Painting 1 Artist", "Example artist");
        expect(native?.tokenCount).toBe(1);
        expect(by("Artist", "Example artist")).toBeNull();

        documents.set("82", {
            image: "ipfs://fixture-new-block",
            attributes: [
                {
                    trait_type: NFT111K_METADATA.CollectionBlock,
                    value: "Future artwork",
                },
            ],
        });
        db.prepare(
            "INSERT INTO nft_transfer_events(chain_id,collection_id,contract_address,from_address,to_address,token_id,amount,block_number,block_hash,block_timestamp,tx_hash,log_index,kind) VALUES(?,?,?,?,?,'82','1',102,?,1,?,0,'erc721')",
        ).run(
            chainId,
            collectionId,
            contract,
            zeroAddress,
            NFT111K_TEST_OWNER,
            zeroHash,
            zeroHash,
        );
        const mint = await domain.handleDomainSync({
            chainId,
            collectionId,
            fromBlock: 102,
            toBlock: 102,
            mode: "realtime",
            projection: DOMAIN_SYNC_PROJECTION.CurrentState,
            sourceKind: "fixture",
            sourceJobId: "mint",
        });
        expect(mint.updatedTokens.map((token) => token.tokenId)).toEqual([
            "82",
        ]);
        const readsAfterMint = reads;
        const newView = membership("82");
        drain();
        expect(values(newView.generation, "82")).toEqual([
            { key: NFT111K_METADATA.CollectionBlock, value: "Future artwork" },
        ]);
        const descriptor = nft111kTraitCatalog.classify(
            readCanonicalTokenTraits(chainId, collectionId, "81"),
        );
        const run = requestTraitCatalogRebuild({
            chainId,
            collectionId,
            viewId: descriptor.id,
            mapperVersion: nft111kTraitCatalog.availableVersion(descriptor),
        });
        drain();
        expect(
            getTraitCatalogRebuild(chainId, collectionId, run.runId)?.status,
        ).toBe(STATUS.Completed);
        expect(reads).toBe(readsAfterMint);
        expect(by("Painting 1 Artist", "Example artist")?.merkleRoot).toBe(
            native?.merkleRoot,
        );
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) n FROM token_metadata WHERE chain_id=? AND collection_id=? AND (uri IS NOT NULL OR raw_json IS NOT NULL OR attributes_json IS NOT NULL)",
                )
                .get(chainId, collectionId),
        ).toEqual({ n: 0 });
        new SqliteCollectionPurgeRepository().purgeCollectionData({
            chainId,
            collectionId,
        });
    });
});
