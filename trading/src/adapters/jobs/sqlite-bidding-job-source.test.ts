import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND } from "@artgod/shared/extensions";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { EVM_PENDING_NONCE_POLICY } from "@artgod/shared/evm/transactions";
import {
    COLLECTION_STANDARD,
    COLLECTION_STATUS,
    TRADING_BOT_KIND,
    TRADING_JOB_STATUS,
    TRADING_JOB_TARGET_KIND,
} from "@artgod/shared/types";
import { SqliteBiddingJobSource } from "./sqlite-bidding-job-source.js";
import { BIDDER_TARGET_TYPE } from "../../domain/market/strategy/job.js";
import { BiddingMandate } from "../../domain/bidding-mandate.js";
import { MarketEvent, Scope, Type } from "../../domain/market/event.js";
import { Bidder } from "../../application/use-cases/bidding/bidder.js";
import {
    BIDDING_ORDER_RECOVERY_STATUS,
    type BiddingService,
} from "../../application/use-cases/bidding/bidding-service.js";
import {
    collectSnapshotBackedCollectionSlugs,
    collectTokenWarmCandidateCount,
    collectWatchedCollectionSlugs,
} from "../../runtime/bidding-runtime.js";

// Job source tests verify market-slug mapping with a private fixture collection.
const JOB_SOURCE_COLLECTION_SLUG = "job-source-fixture";
const JOB_SOURCE_MARKET_SLUG = "job-source-fixture-opensea";
const GRAILS_MARKET_SLUG = "grails-opensea";

async function createTempDbPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "artgod-trading-job-source-"));
    return join(dir, "main.sqlite");
}

function seedCollection(params: {
    slug: string;
    address: string;
    openseaSlug: string | null;
}): number {
    const result = db
        .prepare<{
            chainId: number;
            slug: string;
            address: string;
            standard: string;
            status: string;
            tokenScopeKind: string;
            openseaSlug: string | null;
        }>(
            "INSERT INTO collections " +
                "(chain_id, slug, address, standard, status, token_scope_kind, opensea_slug) " +
                "VALUES (@chainId, @slug, @address, @standard, @status, @tokenScopeKind, @openseaSlug)",
        )
        .run({
            chainId: 1,
            slug: params.slug,
            address: params.address,
            standard: COLLECTION_STANDARD.Erc721,
            status: COLLECTION_STATUS.Live,
            tokenScopeKind:
                EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.AllContractTokens,
            openseaSlug: params.openseaSlug,
        });

    return Number(result.lastInsertRowid);
}

function seedJob(params: {
    jobId: string;
    collectionId: number;
    status: string;
    targetKind: string;
    tokenId: string | null;
    quantity?: number | null;
    targetTraitsJson?: string | null;
    competitorTraitsJson?: string | null;
}): void {
    // Persist the declared bidding job envelope exactly as the runtime will read it on startup.
    db.prepare<{
        jobId: string;
        botKind: string;
        chainId: number;
        collectionId: number;
        status: string;
        targetKind: string;
        tokenId: string | null;
    }>(
        "INSERT INTO trading_jobs " +
            "(job_id, bot_kind, chain_id, collection_id, status, target_kind, token_id) " +
            "VALUES (@jobId, @botKind, @chainId, @collectionId, @status, @targetKind, @tokenId)",
    ).run({
        jobId: params.jobId,
        botKind: TRADING_BOT_KIND.Bidding,
        chainId: 1,
        collectionId: params.collectionId,
        status: params.status,
        targetKind: params.targetKind,
        tokenId: params.tokenId,
    });

    // Persist the bidding strategy spec that the runtime maps into BidderJob.config and target fields.
    db.prepare<{
        jobId: string;
        floorWei: string;
        ceilingWei: string;
        deltaWei: string;
        quantity: number | null;
        targetTraitsJson: string | null;
        competitorTraitsJson: string | null;
    }>(
        "INSERT INTO trading_bidding_job_specs " +
            "(job_id, floor_wei, ceiling_wei, delta_wei, quantity, target_traits_json, competitor_traits_json) " +
            "VALUES (@jobId, @floorWei, @ceilingWei, @deltaWei, @quantity, @targetTraitsJson, @competitorTraitsJson)",
    ).run({
        jobId: params.jobId,
        floorWei: "100000000000000000",
        ceilingWei: "200000000000000000",
        deltaWei: "1000000000000000",
        quantity: params.quantity ?? null,
        targetTraitsJson: params.targetTraitsJson ?? null,
        competitorTraitsJson: params.competitorTraitsJson ?? null,
    });
}

function createMandate(collectionIds: number[]): BiddingMandate {
    return BiddingMandate.parse(
        {
            chainId: 1,
            startPolicy: {
                wethAllowanceCapWei: "1000000000000000000",
                trustOpenSeaSignedZoneTraitOffers: true,
                wethApproval: {
                    minPriorityFeePerGasWei: "1",
                    maxFeePerGasWei: "10",
                    maxTotalGasFeeWei: "1000",
                    pendingNoncePolicy: EVM_PENDING_NONCE_POLICY.Fail,
                },
            },
            collections: collectionIds.map((collectionId) => {
                const row = db
                    .prepare(
                        "SELECT slug, address, opensea_slug FROM collections WHERE collection_id = ?",
                    )
                    .get(collectionId) as {
                    slug: string;
                    address: string;
                    opensea_slug: string;
                };
                return {
                    collectionId,
                    artgodSlug: row.slug,
                    contractAddress: row.address,
                    openseaSlug: row.opensea_slug,
                    maxUnitBidWei: "1000000000000000000",
                    maxQuantity: 2,
                };
            }),
        },
        1,
    );
}

describe("SqliteBiddingJobSource", () => {
    let marketCollectionId = 0;
    let grailsCollectionId = 0;

    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        const migrationRunner = createMigrationRunner();
        await migrationRunner.runMigrations();

        marketCollectionId = seedCollection({
            slug: JOB_SOURCE_COLLECTION_SLUG,
            address: "0x1111111111111111111111111111111111111111",
            openseaSlug: JOB_SOURCE_MARKET_SLUG,
        });
        grailsCollectionId = seedCollection({
            slug: "grails",
            address: "0x2222222222222222222222222222222222222222",
            openseaSlug: GRAILS_MARKET_SLUG,
        });
    });

    it("loads enabled bidding jobs from SQLite and maps each target kind into BidderJob", async () => {
        seedJob({
            jobId: "job-token",
            collectionId: marketCollectionId,
            status: TRADING_JOB_STATUS.Enabled,
            targetKind: TRADING_JOB_TARGET_KIND.Token,
            tokenId: "123",
        });
        seedJob({
            jobId: "job-collection",
            collectionId: grailsCollectionId,
            status: TRADING_JOB_STATUS.Enabled,
            targetKind: TRADING_JOB_TARGET_KIND.Collection,
            tokenId: null,
            quantity: 2,
            targetTraitsJson: JSON.stringify([
                { type: "Background", value: "Gold" },
            ]),
        });
        seedJob({
            jobId: "job-competitive",
            collectionId: marketCollectionId,
            status: TRADING_JOB_STATUS.Enabled,
            targetKind: TRADING_JOB_TARGET_KIND.CompetitiveTrait,
            tokenId: null,
            quantity: 1,
            targetTraitsJson: JSON.stringify([
                { type: "Biome", value: "Flow" },
            ]),
            competitorTraitsJson: JSON.stringify([
                { type: "Biome", value: "Flow" },
            ]),
        });

        db.prepare(
            "INSERT INTO trading_bidding_competition_presets (preset_id, chain_id, collection_id, revision) VALUES (?, ?, ?, 2)",
        ).run("source-preset", 1, grailsCollectionId);
        db.prepare(
            "INSERT INTO trading_bidding_competition_preset_versions (version_id, preset_id, revision, target_traits_json, extra_traits_json) VALUES (?, ?, ?, ?, ?)",
        ).run(
            "source-v1",
            "source-preset",
            1,
            JSON.stringify([{ type: "Background" }]),
            JSON.stringify([
                { type: "Mode" },
                { type: "Zone", value: "Kairo" },
            ]),
        );
        db.prepare(
            "INSERT INTO trading_bidding_competition_preset_versions (version_id, preset_id, revision, target_traits_json, extra_traits_json) VALUES (?, ?, ?, ?, ?)",
        ).run(
            "source-v2",
            "source-preset",
            2,
            JSON.stringify([{ type: "Background", value: "Gold" }]),
            JSON.stringify([{ type: "Biome" }]),
        );
        db.prepare(
            "UPDATE trading_bidding_job_specs SET competition_preset_version_id = ? WHERE job_id = ?",
        ).run("source-v1", "job-collection");
        const source = new SqliteBiddingJobSource(
            createMandate([marketCollectionId, grailsCollectionId]),
        );
        const jobs = await source.loadEnabledJobs();
        const jobsById = new Map(jobs.map((job) => [job.id, job]));

        assert.equal(jobs.length, 3);

        assert.deepEqual(jobsById.get("job-token"), {
            id: "job-token",
            revision: 1,
            network: "eth",
            collectionId: marketCollectionId,
            collectionAddress: "0x1111111111111111111111111111111111111111",
            collectionSlug: JOB_SOURCE_MARKET_SLUG,
            target: {
                type: BIDDER_TARGET_TYPE.Token,
                tokenId: "123",
            },
            config: {
                floor: 100000000000000000n,
                ceiling: 200000000000000000n,
                delta: 1000000000000000n,
            },
            state: {},
        });

        assert.deepEqual(jobsById.get("job-collection"), {
            id: "job-collection",
            revision: 1,
            network: "eth",
            collectionId: grailsCollectionId,
            collectionAddress: "0x2222222222222222222222222222222222222222",
            collectionSlug: GRAILS_MARKET_SLUG,
            target: {
                type: BIDDER_TARGET_TYPE.Collection,
                quantity: 2,
                traits: [{ type: "Background", value: "Gold" }],
            },
            config: {
                floor: 100000000000000000n,
                ceiling: 200000000000000000n,
                delta: 1000000000000000n,
                extraCompetitionTraits: [
                    { type: "Mode" },
                    { type: "Zone", value: "Kairo" },
                ],
            },
            state: {},
        });

        assert.deepEqual(jobsById.get("job-competitive"), {
            id: "job-competitive",
            revision: 1,
            network: "eth",
            collectionId: marketCollectionId,
            collectionAddress: "0x1111111111111111111111111111111111111111",
            collectionSlug: JOB_SOURCE_MARKET_SLUG,
            target: {
                type: BIDDER_TARGET_TYPE.CompetitiveTrait,
                quantity: 1,
                targetTrait: { type: "Biome", value: "Flow" },
                competitorTraits: [{ type: "Biome", value: "Flow" }],
            },
            config: {
                floor: 100000000000000000n,
                ceiling: 200000000000000000n,
                delta: 1000000000000000n,
            },
            state: {},
        });
    });

    it("skips an unmandated enabled job without decoding its missing OpenSea identity", async () => {
        const collectionId = seedCollection({
            slug: "missing-opensea-identity",
            address: "0x3333333333333333333333333333333333333333",
            openseaSlug: null,
        });
        seedJob({
            jobId: "job-without-opensea-slug",
            collectionId,
            status: TRADING_JOB_STATUS.Enabled,
            targetKind: TRADING_JOB_TARGET_KIND.Token,
            tokenId: "1",
        });

        const source = new SqliteBiddingJobSource(
            createMandate([marketCollectionId]),
        );
        assert.deepEqual(await source.loadEnabledJobs(), []);
        assert.equal(
            await source.loadEnabledJobById("job-without-opensea-slug"),
            null,
        );
        assert.equal(
            (await source.loadJobById("job-without-opensea-slug"))?.job
                .collectionSlug,
            "missing-opensea-identity",
        );
    });

    it("excludes every unauthorized target from startup, warmup, scans and hot refresh", async () => {
        seedJob({
            jobId: "authorized-token",
            collectionId: marketCollectionId,
            status: TRADING_JOB_STATUS.Enabled,
            targetKind: TRADING_JOB_TARGET_KIND.Token,
            tokenId: "1",
        });
        for (const [jobId, targetKind, traits] of [
            ["unauthorized-token", TRADING_JOB_TARGET_KIND.Token, []],
            ["unauthorized-collection", TRADING_JOB_TARGET_KIND.Collection, []],
            [
                "unauthorized-traits",
                TRADING_JOB_TARGET_KIND.Collection,
                [{ type: "Biome", value: "Flow" }],
            ],
            [
                "unauthorized-competitive",
                TRADING_JOB_TARGET_KIND.CompetitiveTrait,
                [{ type: "Biome", value: "Flow" }],
            ],
        ] as const) {
            seedJob({
                jobId,
                collectionId: grailsCollectionId,
                status: TRADING_JOB_STATUS.Enabled,
                targetKind,
                tokenId:
                    targetKind === TRADING_JOB_TARGET_KIND.Token ? "1" : null,
                quantity: 1,
                targetTraitsJson: JSON.stringify(traits),
                competitorTraitsJson: JSON.stringify(traits),
            });
        }
        const source = new SqliteBiddingJobSource(
            createMandate([marketCollectionId]),
        );
        const jobs = await source.loadEnabledJobs();
        assert.deepEqual(
            jobs.map((job) => job.id),
            ["authorized-token"],
        );
        assert.deepEqual(collectWatchedCollectionSlugs(jobs), [
            JOB_SOURCE_MARKET_SLUG,
        ]);
        assert.deepEqual(collectSnapshotBackedCollectionSlugs(jobs), [
            JOB_SOURCE_MARKET_SLUG,
        ]);
        assert.equal(collectTokenWarmCandidateCount(jobs), 1);

        const reads: string[] = [];
        const warmups: string[] = [];
        const service: BiddingService = {
            roundOfferPriceDown: (amount) => amount,
            roundOfferPriceUp: (amount) => amount,
            getActiveOffers: async (job) => {
                reads.push(job.id);
                return [];
            },
            getActiveTokenOfferByMaker: async (job) => {
                warmups.push(job.id);
                return null;
            },
            getOrder: async () => ({
                status: BIDDING_ORDER_RECOVERY_STATUS.InactiveOrMissing,
            }),
            placeOffer: async () => {
                throw new Error("Unexpected placement");
            },
            cancelOffer: async () => {
                throw new Error("Unexpected cancellation");
            },
            cancelRecoveredOrder: async () => {
                throw new Error("Unexpected cancellation");
            },
        };
        const bidder = new Bidder(
            service,
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            60_000,
            { dryRun: true },
        );
        jobs.forEach((job) => bidder.addJob(job));
        await bidder.bootstrapCurrentPrices();
        await bidder.scanOnce();
        await bidder.scanOnce();
        const event = new MarketEvent(
            new Date().toISOString(),
            Type.ItemReceivedBid,
            "0xcompetitor",
            GRAILS_MARKET_SLUG,
            "1",
            "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            1,
            "WETH",
            18,
            Scope.Item,
        );
        event.setTotalPrice(110000000000000000n);
        await bidder.refreshMatchingJobs(event);
        assert.deepEqual(warmups, ["authorized-token"]);
        assert.deepEqual(reads, ["authorized-token", "authorized-token"]);
    });

    it("checks the ArtGod collection id when another collection adopts the reviewed marketplace identity", async () => {
        const source = new SqliteBiddingJobSource(
            createMandate([marketCollectionId]),
        );
        // Marketplace slugs are unique in SQLite; move this identity to a different ArtGod id.
        db.prepare(
            "UPDATE collections SET opensea_slug = NULL WHERE collection_id = ?",
        ).run(marketCollectionId);
        db.prepare(
            "UPDATE collections SET address = ?, opensea_slug = ? WHERE collection_id = ?",
        ).run(
            "0x1111111111111111111111111111111111111111",
            JOB_SOURCE_MARKET_SLUG,
            grailsCollectionId,
        );
        seedJob({
            jobId: "other-shared-contract-job",
            collectionId: grailsCollectionId,
            status: TRADING_JOB_STATUS.Enabled,
            targetKind: TRADING_JOB_TARGET_KIND.Token,
            tokenId: "1",
        });
        // Malformed unauthorized specs must not delay or fail authorized startup/commands.
        db.prepare(
            "UPDATE trading_bidding_job_specs SET floor_wei = ? WHERE job_id = ?",
        ).run("invalid", "other-shared-contract-job");
        assert.deepEqual(await source.loadEnabledJobs(), []);
        assert.equal(
            await source.loadEnabledJobById("other-shared-contract-job"),
            null,
        );
    });

    it.each([
        ["address", "0x3333333333333333333333333333333333333333"],
        ["opensea_slug", "different-marketplace-identity"],
        ["opensea_slug", null],
    ])(
        "stops admission when the reviewed %s changes to %s",
        async (field, value) => {
            seedJob({
                jobId: "identity-drift",
                collectionId: marketCollectionId,
                status: TRADING_JOB_STATUS.Enabled,
                targetKind: TRADING_JOB_TARGET_KIND.Token,
                tokenId: "1",
            });
            const source = new SqliteBiddingJobSource(
                createMandate([marketCollectionId]),
            );
            assert.equal((await source.loadEnabledJobs()).length, 1);
            db.prepare(
                `UPDATE collections SET ${field} = ? WHERE collection_id = ?`,
            ).run(value, marketCollectionId);
            assert.deepEqual(await source.loadEnabledJobs(), []);
            assert.equal(
                await source.loadEnabledJobById("identity-drift"),
                null,
            );
            assert.equal(
                (await source.loadJobById("identity-drift"))?.job.id,
                "identity-drift",
            );
        },
    );

    it("loads the latest saved spec at the next authorized boot without requiring the skipped command", async () => {
        seedJob({
            jobId: "later-authorized",
            collectionId: grailsCollectionId,
            status: TRADING_JOB_STATUS.Enabled,
            targetKind: TRADING_JOB_TARGET_KIND.Token,
            tokenId: "1",
        });
        const currentSource = new SqliteBiddingJobSource(
            createMandate([marketCollectionId]),
        );
        assert.deepEqual(await currentSource.loadEnabledJobs(), []);
        db.prepare("UPDATE trading_jobs SET revision = 2 WHERE job_id = ?").run(
            "later-authorized",
        );
        db.prepare(
            "UPDATE trading_bidding_job_specs SET floor_wei = ? WHERE job_id = ?",
        ).run("150000000000000000", "later-authorized");
        assert.equal(
            await currentSource.loadEnabledJobById("later-authorized"),
            null,
        );

        const nextSource = new SqliteBiddingJobSource(
            createMandate([grailsCollectionId]),
        );
        const [job] = await nextSource.loadEnabledJobs();
        assert.equal(job?.revision, 2);
        assert.equal(job?.config.floor, 150000000000000000n);
        assert.equal(
            (await nextSource.loadJobById("later-authorized"))?.status,
            TRADING_JOB_STATUS.Enabled,
        );
    });

    it("filters out paused and archived jobs and hydrates runtime state", async () => {
        seedJob({
            jobId: "job-enabled",
            collectionId: marketCollectionId,
            status: TRADING_JOB_STATUS.Enabled,
            targetKind: TRADING_JOB_TARGET_KIND.Token,
            tokenId: "1",
        });
        seedJob({
            jobId: "job-paused",
            collectionId: marketCollectionId,
            status: TRADING_JOB_STATUS.Paused,
            targetKind: TRADING_JOB_TARGET_KIND.Token,
            tokenId: "2",
        });
        seedJob({
            jobId: "job-archived",
            collectionId: marketCollectionId,
            status: TRADING_JOB_STATUS.Archived,
            targetKind: TRADING_JOB_TARGET_KIND.Token,
            tokenId: "3",
        });

        // Seed runtime state so bot restarts preserve known active order feedback.
        db.prepare<{
            jobId: string;
            jobRevision: number;
            currentPriceWei: string;
            activeOrderId: string;
            activeOrderPlacedAt: string;
            activeOrderVerifiedAt: string;
        }>(
            "INSERT INTO trading_bidding_job_runtime_state " +
                "(job_id, job_revision, current_price_wei, active_order_id, active_order_placed_at, active_order_verified_at) " +
                "VALUES (@jobId, @jobRevision, @currentPriceWei, @activeOrderId, @activeOrderPlacedAt, @activeOrderVerifiedAt)",
        ).run({
            jobId: "job-enabled",
            jobRevision: 1,
            currentPriceWei: "150000000000000000",
            activeOrderId: "0xexisting-order",
            activeOrderPlacedAt: "2026-05-17T00:00:00Z",
            activeOrderVerifiedAt: "2026-05-17T00:00:02Z",
        });

        const source = new SqliteBiddingJobSource(
            createMandate([marketCollectionId, grailsCollectionId]),
        );
        const jobs = await source.loadEnabledJobs();

        assert.equal(jobs.length, 1);
        assert.equal(jobs[0]?.id, "job-enabled");
        assert.deepEqual(jobs[0]?.state, {
            activeOrderId: "0xexisting-order",
            activeOrderPlacedAt: "2026-05-17T00:00:00Z",
            activeOrderVerifiedAt: "2026-05-17T00:00:02Z",
            currentPrice: 150000000000000000n,
            activeProtocolAddress: undefined,
            activeExpirationTimeMs: undefined,
        });
    });

    it("does not hydrate runtime state written for an older job revision", async () => {
        seedJob({
            jobId: "job-enabled",
            collectionId: marketCollectionId,
            status: TRADING_JOB_STATUS.Enabled,
            targetKind: TRADING_JOB_TARGET_KIND.Token,
            tokenId: "1",
        });
        db.prepare("UPDATE trading_jobs SET revision = 2 WHERE job_id = ?").run(
            "job-enabled",
        );
        db.prepare<{
            jobId: string;
            jobRevision: number;
            currentPriceWei: string;
            activeOrderId: string;
        }>(
            "INSERT INTO trading_bidding_job_runtime_state " +
                "(job_id, job_revision, current_price_wei, active_order_id) " +
                "VALUES (@jobId, @jobRevision, @currentPriceWei, @activeOrderId)",
        ).run({
            jobId: "job-enabled",
            jobRevision: 1,
            currentPriceWei: "150000000000000000",
            activeOrderId: "0xold-order",
        });

        const source = new SqliteBiddingJobSource(
            createMandate([marketCollectionId, grailsCollectionId]),
        );
        const job = (await source.loadEnabledJobs())[0];

        assert.equal(job?.revision, 2);
        assert.deepEqual(job?.state, {});
        const cancellationRecord = await source.loadJobById("job-enabled");
        assert.equal(
            cancellationRecord?.job.state.activeOrderId,
            "0xold-order",
        );
        assert.equal(cancellationRecord?.activeOrderJobRevision, 1);
    });
});
