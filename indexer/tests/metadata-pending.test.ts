import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { zeroAddress } from "viem";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { logger } from "@artgod/shared/utils";
import { RpcBudgetDeferred } from "@artgod/shared/evm/rpc-budget";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import { IMAGE_CACHE_MODE } from "@artgod/shared/media/token-image-cache";
import { TOKEN_IMAGE_CACHE_JOB_KIND } from "@artgod/shared/media/token-image-cache-jobs";
import {
    NFT111K_MAINNET_CHAIN_ID,
    NFT111K_MAINNET_CONTRACT_ADDRESS,
    NFT111K_EXTENSION_KEY,
} from "@artgod/shared/extensions/111k";
import { SqliteCollectionPurgeRepository } from "../../backend/src/infra/collections/sqlite-collection-purge-repository.js";
import { MetadataDomain } from "../src/application/metadata/domain.js";
import { createMetadataPendingFollowups } from "../src/application/metadata/pending-followups.js";
import { CollectionExtensionMetadataReadiness } from "../src/application/collection-extensions/metadata-readiness.js";
import {
    NFT111K_METADATA,
    isNft111kMetadataReady,
} from "../src/application/collection-extensions/111k.js";
import {
    METADATA_PENDING_POLICY as POLICY,
    METADATA_PENDING_REASON as REASON,
    METADATA_PENDING_LOG,
} from "../src/domain/metadata-pending.js";
import {
    DOMAIN_JOB_KIND,
    METADATA_REFRESH_REASON,
    DOMAIN_SYNC_PROJECTION,
} from "../src/domain/domain-jobs.js";
import type { TokenMetadata } from "../src/domain/metadata.js";
import { SqliteMetadataStore } from "../src/infra/metadata/sqlite-metadata-store.js";
import { SqliteCollectionExtensions } from "../src/infra/collection-extensions/sqlite.js";
import { SqliteMetadataRefreshFollowups } from "../src/infra/metadata/sqlite-refresh-followups.js";
import { SqliteQueueOutbox } from "../src/infra/queue/sqlite-queue-outbox.js";
import { advanceChainSyncRevision } from "../src/infra/storage/sqlite-chain-revisions.js";
import {
    nft111kTestInstall,
    NFT111K_TEST_OWNER,
} from "./fixtures/111k-bootstrap.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

const CHAIN = NFT111K_MAINNET_CHAIN_ID;
const CONTRACT = NFT111K_MAINNET_CONTRACT_ADDRESS;
const COLLECTION = 7;
const HASH = "0x" + "11".repeat(32);
const IMAGE = "https://example.invalid/ready.png";
const URI = "https://example.invalid/1.json";
const NO_EFFECT = () => {};

function document(ready = true, name = "current"): TokenMetadata {
    return {
        uri: URI,
        name,
        image: ready ? IMAGE : NFT111K_METADATA.PlaceholderImage,
        attributes: ready
            ? [
                  {
                      traitType: NFT111K_METADATA.CollectionBlock,
                      value: "block-a",
                  },
              ]
            : [],
        rawJson: JSON.stringify({
            [NFT111K_METADATA.RevealStatus]: NFT111K_METADATA.Revealed,
        }),
    };
}

function insertCollection(
    id = COLLECTION,
    status: string = COLLECTION_STATUS.Live,
) {
    db.prepare(
        "INSERT INTO collections(chain_id,collection_id,slug,address,standard,status,token_scope_kind,bootstrap_anchor_block) VALUES(?,?,?,?,'erc721',?,'contract_all_tokens',100)",
    ).run(
        CHAIN,
        id,
        `pending-${id}`,
        id === COLLECTION ? CONTRACT : "0x" + id.toString(16).padStart(40, "0"),
        status,
    );
}
function insertOwner(tokenId = "1", collectionId = COLLECTION) {
    const address = (
        db
            .prepare("SELECT address FROM collections WHERE collection_id=?")
            .get(collectionId) as { address: string }
    ).address;
    db.prepare(
        "INSERT INTO nft_balances(chain_id,collection_id,contract_address,token_id,owner,amount,last_block_number,last_block_hash,last_block_timestamp,last_tx_hash,last_log_index) VALUES(?,?,?,?,?,'1',101,?,1,?,0)",
    ).run(
        CHAIN,
        collectionId,
        address,
        tokenId,
        NFT111K_TEST_OWNER,
        HASH,
        HASH,
    );
}

function insertBurn(
    tokenId = "1",
    standard: string = COLLECTION_STANDARD.Erc721,
) {
    db.prepare(
        "INSERT INTO nft_transfer_events(chain_id,collection_id,contract_address,from_address,to_address,token_id,amount,block_number,block_hash,block_timestamp,tx_hash,log_index,kind) VALUES(?,?,?,?,?,?,'1',102,?,1,?,?,?)",
    ).run(
        CHAIN,
        COLLECTION,
        CONTRACT,
        NFT111K_TEST_OWNER,
        zeroAddress,
        tokenId,
        HASH,
        HASH,
        Number(tokenId),
        standard,
    );
}
function fixture(extension = true) {
    insertCollection();
    insertOwner();
    const installs = new SqliteCollectionExtensions({
        persistRawDebugPayloads: false,
    });
    if (extension) installs.upsertInstall(nft111kTestInstall());
    const store = new SqliteMetadataStore({ persistRawDebugPayloads: false });
    const state = {
        now: 1_000_000,
        uri: URI as string | null,
        metadata: document(false) as TokenMetadata | null,
    };
    const blocks: (number | undefined)[] = [];
    const options: unknown[] = [];
    const resolver = {
        resolveTokenUri: vi.fn(
            async (
                _contract: string,
                _tokenId: string,
                _standard: string,
                block?: number,
            ) => {
                blocks.push(block);
                return state.uri;
            },
        ),
    };
    const fetcher = {
        fetchMetadata: vi.fn(async (_uri: string, config?: unknown) => {
            options.push(config);
            return state.metadata;
        }),
    };
    const domain = new MetadataDomain({
        resolver,
        fetcher,
        store,
        readiness: new CollectionExtensionMetadataReadiness(installs),
        now: () => state.now,
    });
    return {
        state,
        domain,
        store,
        installs,
        resolver,
        fetcher,
        blocks,
        options,
        refresh: () =>
            domain.handleMetadataRefresh({
                chainId: CHAIN,
                collectionId: COLLECTION,
                tokenId: "1",
                reason: METADATA_REFRESH_REASON.BootstrapSnapshot,
            }),
        due: () => {
            state.now += POLICY.retryMaxMs + 1;
        },
        row: () =>
            db
                .prepare(
                    "SELECT * FROM metadata_pending WHERE collection_id=? AND token_id='1'",
                )
                .get(COLLECTION) as
                | {
                      attempts: number;
                      due_at: number;
                      first_pending_at: number;
                      lease_owner: string | null;
                      reason: string;
                  }
                | undefined,
        image: () =>
            (
                db
                    .prepare(
                        "SELECT image FROM token_metadata WHERE collection_id=? AND token_id='1'",
                    )
                    .get(COLLECTION) as { image: string } | undefined
            )?.image,
    };
}

describe("durable metadata pending backlog", () => {
    loadTestEnv();
    beforeAll(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });
    beforeEach(() => {
        for (const table of [
            "metadata_pending",
            "metadata_refresh_extension_artifact_tasks",
            "metadata_refresh_runs",
            "queue_outbox",
            "token_attributes",
            "attributes",
            "attribute_keys",
            "token_metadata",
            "tokens",
            "nft_balances",
            "nft_transfer_events",
            "collection_extension_installs",
            "collections",
            "chain_sync_revisions",
        ])
            db.exec(`DELETE FROM ${table}`);
    });

    it("retains successful placeholders, then commits a later root and removes pending intent", async () => {
        const f = fixture();
        expect(await f.refresh()).not.toBeNull();
        expect(f.image()).toBe(NFT111K_METADATA.PlaceholderImage);
        expect(f.row()?.reason).toBe(REASON.NotReady);
        expect(f.row()?.due_at).toBeGreaterThan(f.state.now);
        f.state.metadata = document();
        f.due();
        const effect = vi.fn();
        await f.domain.retryPending(CHAIN, effect);
        expect(f.image()).toBe(IMAGE);
        expect(f.row()).toBeUndefined();
        expect(effect).toHaveBeenCalledOnce();
        expect(db.prepare("SELECT raw_json FROM token_metadata").get()).toEqual(
            { raw_json: null },
        );
        expect(
            db
                .prepare(
                    "SELECT a.value FROM token_attributes t JOIN attributes a ON a.id=t.attribute_id JOIN attribute_keys k ON k.id=a.attribute_key_id WHERE k.key=?",
                )
                .get(NFT111K_METADATA.CollectionBlock),
        ).toEqual({ value: "block-a" });
    });

    it("logs each extension rejection with its fetchable URL and identity, even with raw persistence disabled", async () => {
        const f = fixture();
        const metadataUrl = URI + "?view=full#metadata";
        f.state.uri = metadataUrl;
        f.state.metadata!.uri = metadataUrl;
        const log = vi.spyOn(logger, "info").mockImplementation(() => {});
        try {
            await f.refresh();
            f.due();
            await f.domain.retryPending(CHAIN, NO_EFFECT);
            const rejected = () =>
                log.mock.calls.filter(
                    ([message]) => message === METADATA_PENDING_LOG.NotReady,
                );
            expect(rejected()).toHaveLength(2);
            for (const [, context] of rejected())
                expect(context).toEqual({
                    component: METADATA_PENDING_LOG.Component,
                    chainId: CHAIN,
                    collectionId: COLLECTION,
                    contract: CONTRACT,
                    tokenId: "1",
                    extensionKey: NFT111K_EXTENSION_KEY,
                    metadataUrl,
                });
            f.state.metadata = { ...document(), uri: metadataUrl };
            f.due();
            await f.domain.retryPending(CHAIN, NO_EFFECT);
            expect(rejected()).toHaveLength(2);
            expect(
                db
                    .prepare(
                        "SELECT uri,raw_json FROM token_metadata WHERE collection_id=? AND token_id='1'",
                    )
                    .get(COLLECTION),
            ).toEqual({ uri: null, raw_json: null });
        } finally {
            log.mockRestore();
        }
    });

    it("keeps one permanent row beyond ordinary queue retry/age limits", async () => {
        const f = fixture();
        await f.refresh();
        const first = f.row()!.first_pending_at;
        for (let i = 0; i < 20; i++) {
            f.due();
            await f.domain.retryPending(CHAIN, NO_EFFECT);
        }
        expect(f.row()).toMatchObject({
            attempts: 21,
            first_pending_at: first,
            lease_owner: null,
            reason: REASON.NotReady,
        });
        expect(f.row()!.due_at - f.state.now).toBeLessThanOrEqual(
            POLICY.retryMaxMs,
        );
        expect(
            db.prepare("SELECT count(*) n FROM metadata_pending").get(),
        ).toEqual({ n: 1 });
        expect(db.prepare("SELECT count(*) n FROM queue_outbox").get()).toEqual(
            { n: 0 },
        );
    });

    it.each(["uri", "fetch"] as const)(
        "recovers generic %s failures from SQLite after runtime reconstruction",
        async (failure) => {
            const f = fixture(false);
            f.state.metadata = document();
            if (failure === "uri") f.state.uri = null;
            else f.state.metadata = null;
            expect(await f.refresh()).toBeNull();
            expect(f.row()).toBeDefined();
            f.state.uri = URI;
            f.state.metadata = document();
            f.due();
            const restarted = new MetadataDomain({
                resolver: f.resolver,
                fetcher: f.fetcher,
                store: new SqliteMetadataStore(),
                readiness: new CollectionExtensionMetadataReadiness(f.installs),
                now: () => f.state.now,
            });
            await restarted.retryPending(CHAIN, NO_EFFECT);
            expect(f.image()).toBe(IMAGE);
            expect(f.row()).toBeUndefined();
        },
    );

    it("retains local allocation waits without inflating hosting backoff", async () => {
        const f = fixture();
        for (let i = 0; i < 8; i++) {
            f.resolver.resolveTokenUri.mockRejectedValueOnce(
                new RpcBudgetDeferred(7_500),
            );
            expect(await f.refresh()).toBeNull();
            expect(f.row()).toMatchObject({
                attempts: i + 1,
                failures: 0,
                reason: REASON.Deferred,
                due_at: f.state.now + 7_500,
                lease_owner: null,
            });
            f.state.now += 7_501;
        }
        await f.domain.retryPending(CHAIN, NO_EFFECT);
        expect(f.row()).toMatchObject({ attempts: 9, failures: 1 });
        expect(f.row()!.due_at - f.state.now).toBeLessThanOrEqual(
            POLICY.retryBaseMs,
        );
        f.due();
        f.state.metadata = document();
        await f.domain.retryPending(CHAIN, NO_EFFECT);
        expect(f.image()).toBe(IMAGE);
        expect(f.row()).toBeUndefined();
    });

    it("does not turn superseded quota waits into host failures", async () => {
        const f = fixture();
        let rejectFirst!: (error: Error) => void;
        let started!: () => void;
        const begin = new Promise<void>((resolve) => {
            started = resolve;
        });
        f.resolver.resolveTokenUri.mockImplementationOnce(async () => {
            started();
            return new Promise<string>((_resolve, reject) => {
                rejectFirst = reject;
            });
        });
        const first = f.refresh();
        await begin;
        f.resolver.resolveTokenUri.mockRejectedValueOnce(
            new RpcBudgetDeferred(1_000),
        );
        await f.refresh();
        rejectFirst(new RpcBudgetDeferred(1_000));
        await first;
        expect(f.row()).toMatchObject({ attempts: 2, failures: 0 });
        f.due();
        await f.domain.retryPending(CHAIN, NO_EFFECT);
        expect(f.row()).toMatchObject({ attempts: 3, failures: 1 });
        expect(f.row()!.due_at - f.state.now).toBeLessThanOrEqual(
            POLICY.retryBaseMs,
        );
    });

    it("coalesces repeated signals without losing the original pending age", async () => {
        const f = fixture();
        await f.refresh();
        const first = f.row()!.first_pending_at;
        for (let i = 0; i < 5; i++) {
            f.state.now++;
            await f.refresh();
        }
        expect(f.row()).toMatchObject({ attempts: 6, first_pending_at: first });
        expect(
            db.prepare("SELECT count(*) n FROM metadata_pending").get(),
        ).toEqual({ n: 1 });
    });

    it("reclaims expired leases and rejects old ownership even after delete/reinsert", async () => {
        const f = fixture();
        await f.refresh();
        f.due();
        const first = f.store.claimDue(CHAIN, f.state.now)!;
        expect(f.store.claimDue(CHAIN, f.state.now)).toBeNull();
        f.state.now += POLICY.leaseMs + 1;
        const second = new SqliteMetadataStore().claimDue(CHAIN, f.state.now)!;
        expect(second.owner).not.toBe(first.owner);
        expect(
            f.store.complete(first, document(), true, f.state.now),
        ).toBeNull();
        expect(
            f.store.complete(second, document(), true, f.state.now),
        ).not.toBeNull();
        const third = f.store.begin(second.target, {}, f.state.now)!;
        expect(
            f.store.complete(first, document(true, "stale"), true, f.state.now),
        ).toBeNull();
        expect(f.row()!.lease_owner).toBe(third.owner);
    });

    it("retains bootstrap failures until live, preserving media selection but dropping historical RPC pinning", async () => {
        const f = fixture();
        db.prepare("UPDATE collections SET status=?").run(
            COLLECTION_STATUS.Bootstrapping,
        );
        db.exec("DELETE FROM nft_balances");
        f.state.metadata = null;
        await f.domain.handleMetadataRefresh({
            chainId: CHAIN,
            collectionId: COLLECTION,
            tokenId: "1",
            blockNumber: 100,
            imageSourceField: "preview",
            animationSourceField: null,
            reason: METADATA_REFRESH_REASON.BootstrapSnapshot,
        });
        expect(f.row()).toBeDefined();
        f.due();
        expect(await f.domain.retryPending(CHAIN, NO_EFFECT)).toBeNull();
        db.prepare("UPDATE collections SET status=?").run(
            COLLECTION_STATUS.Live,
        );
        insertOwner();
        f.state.metadata = document();
        await f.domain.retryPending(CHAIN, NO_EFFECT);
        expect(f.blocks).toEqual([100, undefined]);
        expect(f.options.at(-1)).toEqual({
            imageSourceField: "preview",
            animationSourceField: null,
        });
        expect(f.row()).toBeUndefined();
    });

    it.each([COLLECTION_STATUS.Paused, COLLECTION_STATUS.Disabled])(
        "retains new and existing obligations while %s",
        async (status) => {
            const f = fixture();
            db.prepare("UPDATE collections SET status=?").run(status);
            expect(await f.refresh()).toBeNull();
            expect(f.fetcher.fetchMetadata).not.toHaveBeenCalled();
            expect(f.row()).toBeDefined();
            f.due();
            expect(await f.domain.retryPending(CHAIN, NO_EFFECT)).toBeNull();
            expect(f.row()).toBeDefined();
            db.prepare("UPDATE collections SET status=?").run(
                COLLECTION_STATUS.Live,
            );
            f.state.metadata = document();
            await f.domain.retryPending(CHAIN, NO_EFFECT);
            expect(f.row()).toBeUndefined();
        },
    );

    it("does not downgrade previous canonical metadata when a later response becomes incomplete", async () => {
        const f = fixture();
        f.state.metadata = document();
        await f.refresh();
        f.state.metadata = document(false);
        expect(await f.refresh()).toBeNull();
        expect(f.image()).toBe(IMAGE);
        expect(f.row()?.reason).toBe(REASON.NotReady);
    });

    it("atomically retains retry follow-ups with the canonical write, including publication failure recovery", async () => {
        const f = fixture(false);
        f.state.metadata = null;
        await f.refresh();
        f.due();
        f.state.metadata = document();
        const outbox = new SqliteQueueOutbox();
        const effect = createMetadataPendingFollowups({
            chainId: CHAIN,
            followups: new SqliteMetadataRefreshFollowups(outbox),
            extensions: f.installs,
            imagePolicy: {
                getImageCachePolicyConfig: () => ({
                    imageCacheMode: IMAGE_CACHE_MODE.RefreshOnMetadata,
                    maxDimension: null,
                }),
            },
            outbox,
        });
        await expect(
            f.domain.retryPending(CHAIN, (updated, attempt) => {
                effect(updated, attempt);
                throw new Error("retained effects interrupted");
            }),
        ).rejects.toThrow("retained effects interrupted");
        expect(f.image()).toBeUndefined();
        expect(f.row()).toBeDefined();
        expect(db.prepare("SELECT count(*) n FROM queue_outbox").get()).toEqual(
            { n: 0 },
        );
        f.due();
        await f.domain.retryPending(CHAIN, effect);
        expect(f.image()).toBe(IMAGE);
        expect(f.row()).toBeUndefined();
        expect(
            db
                .prepare("SELECT job_kind FROM queue_outbox ORDER BY job_kind")
                .all(),
        ).toEqual([
            { job_kind: DOMAIN_JOB_KIND.MetadataStatsRecompute },
            { job_kind: TOKEN_IMAGE_CACHE_JOB_KIND.RefreshToken },
        ]);
    });

    it("ignores a slow retry after a newer refresh has completed", async () => {
        const f = fixture();
        await f.refresh();
        f.due();
        let reply!: (metadata: TokenMetadata) => void;
        let started!: () => void;
        const begin = new Promise<void>((resolve) => {
            started = resolve;
        });
        f.fetcher.fetchMetadata.mockImplementationOnce(async () => {
            started();
            return new Promise<TokenMetadata>((resolve) => {
                reply = resolve;
            });
        });
        const effect = vi.fn();
        const pending = f.domain.retryPending(CHAIN, effect);
        await begin;
        f.state.metadata = document(true, "newest");
        await f.refresh();
        reply(document(true, "stale"));
        await pending;
        expect(db.prepare("SELECT name FROM token_metadata").get()).toEqual({
            name: "newest",
        });
        expect(effect).not.toHaveBeenCalled();
        expect(f.row()).toBeUndefined();
    });

    it.each([
        "purge",
        "burn",
        "reorg",
        "pause",
        "disable",
        "ownership",
    ] as const)(
        "fences completion after %s during network work",
        async (change) => {
            const f = fixture();
            await f.refresh();
            f.due();
            let reply!: (metadata: TokenMetadata) => void;
            let started!: () => void;
            const begin = new Promise<void>((resolve) => {
                started = resolve;
            });
            f.fetcher.fetchMetadata.mockImplementationOnce(async () => {
                started();
                return new Promise<TokenMetadata>((resolve) => {
                    reply = resolve;
                });
            });
            const effect = vi.fn();
            const pending = f.domain.retryPending(CHAIN, effect);
            await begin;
            if (change === "purge")
                new SqliteCollectionPurgeRepository().purgeCollectionData({
                    chainId: CHAIN,
                    collectionId: COLLECTION,
                });
            if (change === "burn" || change === "ownership") {
                db.exec("DELETE FROM nft_balances");
                if (change === "burn") insertBurn();
            }
            if (change === "reorg")
                db.writeTransaction(() => advanceChainSyncRevision(CHAIN))();
            if (change === "pause" || change === "disable")
                db.prepare("UPDATE collections SET status=?").run(
                    change === "pause"
                        ? COLLECTION_STATUS.Paused
                        : COLLECTION_STATUS.Disabled,
                );
            reply(document());
            await pending;
            expect(effect).not.toHaveBeenCalled();
            expect(f.image()).not.toBe(IMAGE);
            if (
                change === "reorg" ||
                change === "pause" ||
                change === "disable" ||
                change === "ownership"
            )
                expect(f.row()).toBeDefined();
            else expect(f.row()).toBeUndefined();
            if (change === "purge")
                expect(
                    db.prepare("SELECT count(*) n FROM token_metadata").get(),
                ).toEqual({ n: 0 });
        },
    );

    it("keeps ownerless known tokens pending without HTTP until ownership is available", async () => {
        const f = fixture();
        await f.refresh();
        db.exec("DELETE FROM nft_balances");
        f.due();
        expect(await f.domain.retryPending(CHAIN, NO_EFFECT)).toBeNull();
        expect(f.row()).toMatchObject({
            reason: REASON.AwaitingOwnership,
            attempts: 1,
            lease_owner: null,
        });
        expect(f.fetcher.fetchMetadata).toHaveBeenCalledTimes(1);
        insertOwner();
        f.state.now += POLICY.retryBaseMs + 1;
        f.state.metadata = document();
        await f.domain.retryPending(CHAIN, NO_EFFECT);
        expect(f.image()).toBe(IMAGE);
        expect(f.row()).toBeUndefined();
    });

    it("does not infer ERC1155 extinction from an incomplete balance/transfer subset", async () => {
        const f = fixture(false);
        db.prepare("UPDATE collections SET standard=?").run(
            COLLECTION_STANDARD.Erc1155,
        );
        f.state.metadata = null;
        await f.refresh();
        db.exec("DELETE FROM nft_balances");
        insertBurn("1", COLLECTION_STANDARD.Erc1155);
        f.due();
        expect(await f.domain.retryPending(CHAIN, NO_EFFECT)).toBeNull();
        expect(f.row()?.reason).toBe(REASON.AwaitingOwnership);
        expect(f.fetcher.fetchMetadata).toHaveBeenCalledTimes(1);
        insertOwner();
        f.state.now += POLICY.retryBaseMs + 1;
        f.state.metadata = document();
        await f.domain.retryPending(CHAIN, NO_EFFECT);
        expect(f.row()).toBeUndefined();
        expect(f.resolver.resolveTokenUri.mock.calls.at(-1)?.[2]).toBe(
            COLLECTION_STANDARD.Erc1155,
        );
    });

    it("streams transfer candidates across multiple closed reader pages without skipping or duplicating tokens", async () => {
        const f = fixture(false);
        f.state.metadata = document();
        db.writeTransaction(() => {
            const insert = db.prepare(
                "INSERT INTO nft_transfer_events(chain_id,collection_id,contract_address,from_address,to_address,token_id,amount,block_number,block_hash,block_timestamp,tx_hash,log_index,kind) VALUES(?,?,?,?,?,?,'1',?,?,1,?,?,'erc721')",
            );
            for (let i = 1; i <= 260; i++) {
                if (i > 1) insertOwner(String(i));
                insert.run(
                    CHAIN,
                    COLLECTION,
                    CONTRACT,
                    zeroAddress,
                    NFT111K_TEST_OWNER,
                    String(i),
                    101,
                    HASH,
                    HASH,
                    i,
                );
            }
            insert.run(
                CHAIN,
                COLLECTION,
                CONTRACT,
                NFT111K_TEST_OWNER,
                NFT111K_TEST_OWNER,
                "129",
                102,
                HASH,
                HASH,
                1_000,
            );
        })();
        const result = await f.domain.handleDomainSync({
            chainId: CHAIN,
            collectionId: COLLECTION,
            fromBlock: 101,
            toBlock: 102,
            mode: "realtime",
            projection: DOMAIN_SYNC_PROJECTION.CurrentState,
            sourceJobId: "pending-page-fixture",
            sourceKind: "pending-page-fixture",
        });
        expect(result.updatedTokens).toHaveLength(260);
        expect(new Set(result.updatedTokens.map((t) => t.tokenId)).size).toBe(
            260,
        );
        expect(f.resolver.resolveTokenUri).toHaveBeenCalledTimes(260);
        expect(
            db
                .prepare(
                    "SELECT block_number FROM token_metadata WHERE token_id='129'",
                )
                .get(),
        ).toEqual({ block_number: 101 });
        expect(
            db.prepare("SELECT count(*) n FROM metadata_pending").get(),
        ).toEqual({ n: 0 });
    });

    it("does not advance collection traversal when a claim writer rolls back", async () => {
        const f = fixture(false);
        f.state.metadata = null;
        await f.refresh();
        insertCollection(8);
        insertOwner("1", 8);
        const other = f.store.begin(
            f.store.target(CHAIN, 8, "1")!,
            {},
            f.state.now,
        )!;
        f.store.defer(other, REASON.FetchUnavailable, f.state.now, 1);
        f.due();
        db.exec(
            "CREATE TEMP TRIGGER reject_metadata_claim BEFORE UPDATE OF lease_owner ON metadata_pending WHEN NEW.lease_owner IS NOT NULL BEGIN SELECT RAISE(ABORT,'claim aborted'); END",
        );
        try {
            expect(() => f.store.claimDue(CHAIN, f.state.now)).toThrow(
                "claim aborted",
            );
        } finally {
            db.exec("DROP TRIGGER reject_metadata_claim");
        }
        expect(f.store.claimDue(CHAIN, f.state.now)?.target.collectionId).toBe(
            COLLECTION,
        );
    });

    it("rotates past a large obsolete collection and keeps due lookup indexed", async () => {
        const f = fixture();
        await f.refresh();
        f.due();
        db.exec("DELETE FROM nft_balances");
        db.writeTransaction(() => {
            insertBurn();
            for (let i = 2; i < 70; i++) {
                insertBurn(String(i));
                db.prepare(
                    "INSERT INTO metadata_pending(chain_id,collection_id,token_id,options_json,first_pending_at,due_at,reason) VALUES(?,?,?,'{}',0,0,?)",
                ).run(CHAIN, COLLECTION, String(i), REASON.UriUnavailable);
            }
        })();
        insertCollection(8);
        insertOwner("1", 8);
        const target = f.store.target(CHAIN, 8, "1")!;
        const seed = f.store.begin(target, {}, f.state.now)!;
        f.store.defer(seed, REASON.UriUnavailable, f.state.now, 1);
        f.state.now++;
        expect(f.store.claimDue(CHAIN, f.state.now)).toBeNull();
        expect(f.store.claimDue(CHAIN, f.state.now)?.target.collectionId).toBe(
            8,
        );
        const plan = db
            .prepare(
                "EXPLAIN QUERY PLAN SELECT * FROM metadata_pending WHERE chain_id=? AND collection_id=? AND due_at<=? ORDER BY due_at,token_id LIMIT 16",
            )
            .all(CHAIN, COLLECTION, f.state.now) as { detail: string }[];
        expect(
            plan.some((row) =>
                row.detail.includes("metadata_pending_collection_due"),
            ),
        ).toBe(true);
        expect(
            db
                .prepare(
                    "SELECT count(*) n FROM metadata_pending WHERE collection_id=?",
                )
                .get(COLLECTION),
        ).toEqual({ n: 69 - POLICY.obsoletePageSize });
    });
});

describe("111k metadata readiness", () => {
    it("requires the root and media even when the host declares revealed", () => {
        const noRoot = document();
        noRoot.attributes = [];
        expect(isNft111kMetadataReady(noRoot)).toBe(false);
        expect(isNft111kMetadataReady(document(false))).toBe(false);
        const placeholder = document();
        placeholder.image = NFT111K_METADATA.PlaceholderImage + "?v=1";
        expect(isNft111kMetadataReady(placeholder)).toBe(false);
        expect(isNft111kMetadataReady(document())).toBe(true);
    });
    it("requires usable root content and respects an explicitly unrevealed server state", () => {
        const empty = document();
        empty.attributes[0].value = "  ";
        expect(isNft111kMetadataReady(empty)).toBe(false);
        const pending = document();
        pending.rawJson = JSON.stringify({
            [NFT111K_METADATA.RevealStatus]: null,
        });
        expect(isNft111kMetadataReady(pending)).toBe(false);
    });
});
