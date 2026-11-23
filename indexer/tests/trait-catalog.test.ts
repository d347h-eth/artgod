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
import { nft111kTestInstall } from "./fixtures/111k-bootstrap.js";

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
        resolve = () => nft111kTraitCatalog;
        requestTraitCatalogRebuild({ ...request, retryRunId: run.runId });
        drain();
        expect(published()).toBe(run.generation);
        expect(values(run.generation, "1")).toEqual(driMi);
        expect(values(run.generation, "0")).toEqual(driMi);
    });
    it("fences removed observations on rollback and a reused collection ID after purge", () => {
        observe("1", driMi);
        const first = catalog.claim(chainId, 10)!;
        db.prepare("DELETE FROM token_metadata WHERE token_id=?").run("1");
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
});
