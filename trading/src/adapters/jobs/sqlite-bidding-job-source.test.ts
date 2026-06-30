import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    TRADING_BOT_KIND,
    TRADING_JOB_STATUS,
    TRADING_JOB_TARGET_KIND,
} from "@artgod/shared/types";
import { SqliteBiddingJobSource } from "./sqlite-bidding-job-source.js";

async function createTempDbPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "artgod-trading-job-source-"));
    return join(dir, "main.sqlite");
}

function seedCollection(params: {
    slug: string;
    address: string;
    openseaSlug: string | null;
}): number {
    const result = db.prepare<{
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
    ).run({
        chainId: 1,
        slug: params.slug,
        address: params.address,
        standard: "erc721",
        status: "live",
        tokenScopeKind: "contract_all_tokens",
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

describe("SqliteBiddingJobSource", () => {
    let terraformsCollectionId = 0;
    let grailsCollectionId = 0;

    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        const migrationRunner = createMigrationRunner();
        await migrationRunner.runMigrations();

        terraformsCollectionId = seedCollection({
            slug: "artgod-slug",
            address: "0x1111111111111111111111111111111111111111",
            openseaSlug: "terraforms",
        });
        grailsCollectionId = seedCollection({
            slug: "grails",
            address: "0x2222222222222222222222222222222222222222",
            openseaSlug: null,
        });
    });

    it("loads enabled bidding jobs from SQLite and maps each target kind into BidderJob", async () => {
        seedJob({
            jobId: "job-token",
            collectionId: terraformsCollectionId,
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
            collectionId: terraformsCollectionId,
            status: TRADING_JOB_STATUS.Enabled,
            targetKind: TRADING_JOB_TARGET_KIND.CompetitiveTrait,
            tokenId: null,
            quantity: 1,
            targetTraitsJson: JSON.stringify([{ type: "Biome", value: "Flow" }]),
            competitorTraitsJson: JSON.stringify([
                { type: "Biome", value: "Flow" },
            ]),
        });

        const source = new SqliteBiddingJobSource(1);
        const jobs = await source.loadEnabledJobs();
        const jobsById = new Map(jobs.map((job) => [job.id, job]));

        assert.equal(jobs.length, 3);

        assert.deepEqual(jobsById.get("job-token"), {
            id: "job-token",
            revision: 1,
            network: "eth",
            collectionAddress: "0x1111111111111111111111111111111111111111",
            collectionSlug: "terraforms",
            target: {
                type: "token",
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
            collectionAddress: "0x2222222222222222222222222222222222222222",
            collectionSlug: "grails",
            target: {
                type: "collection",
                quantity: 2,
                traits: [{ type: "Background", value: "Gold" }],
            },
            config: {
                floor: 100000000000000000n,
                ceiling: 200000000000000000n,
                delta: 1000000000000000n,
            },
            state: {},
        });

        assert.deepEqual(jobsById.get("job-competitive"), {
            id: "job-competitive",
            revision: 1,
            network: "eth",
            collectionAddress: "0x1111111111111111111111111111111111111111",
            collectionSlug: "terraforms",
            target: {
                type: "competitiveTrait",
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

    it("filters out paused and archived jobs and hydrates runtime state", async () => {
        seedJob({
            jobId: "job-enabled",
            collectionId: terraformsCollectionId,
            status: TRADING_JOB_STATUS.Enabled,
            targetKind: TRADING_JOB_TARGET_KIND.Token,
            tokenId: "1",
        });
        seedJob({
            jobId: "job-paused",
            collectionId: terraformsCollectionId,
            status: TRADING_JOB_STATUS.Paused,
            targetKind: TRADING_JOB_TARGET_KIND.Token,
            tokenId: "2",
        });
        seedJob({
            jobId: "job-archived",
            collectionId: terraformsCollectionId,
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

        const source = new SqliteBiddingJobSource(1);
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
            collectionId: terraformsCollectionId,
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

        const source = new SqliteBiddingJobSource(1);
        const job = (await source.loadEnabledJobs())[0];

        assert.equal(job?.revision, 2);
        assert.deepEqual(job?.state, {});
    });
});
