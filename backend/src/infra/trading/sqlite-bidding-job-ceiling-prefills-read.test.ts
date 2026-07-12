import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND } from "@artgod/shared/extensions";
import {
    COLLECTION_STANDARD,
    COLLECTION_STATUS,
    TRADING_BOT_KIND,
    TRADING_JOB_STATUS,
    TRADING_JOB_TARGET_KIND,
    type TradingBotKind,
    type TradingJobStatus,
    type TradingJobTargetKind,
} from "@artgod/shared/types";
import {
    BIDDING_JOB_CEILING_PREFILLS_SQL,
    SqliteBiddingJobCeilingPrefillsRead,
} from "./sqlite-bidding-job-ceiling-prefills-read.js";

async function createTempDbPath(): Promise<string> {
    const dir = await mkdtemp(
        join(tmpdir(), "artgod-bidding-ceiling-prefills-"),
    );
    return join(dir, "main.sqlite");
}

function seedCollection(params: {
    chainId: number;
    slug: string;
    address: string;
}): number {
    const result = db
        .prepare<{
            chainId: number;
            slug: string;
            address: string;
            standard: string;
            status: string;
            tokenScopeKind: string;
        }>(
            "INSERT INTO collections " +
                "(chain_id, slug, address, standard, status, token_scope_kind) " +
                "VALUES (@chainId, @slug, @address, @standard, @status, @tokenScopeKind)",
        )
        .run({
            ...params,
            standard: COLLECTION_STANDARD.Erc721,
            status: COLLECTION_STATUS.Live,
            tokenScopeKind:
                EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.AllContractTokens,
        });
    return Number(result.lastInsertRowid);
}

type SeedJobRecord = {
    jobId: string;
    chainId: number;
    collectionId: number;
    botKind?: TradingBotKind;
    status?: TradingJobStatus;
    targetKind: TradingJobTargetKind;
};

function seedJobRecord(params: SeedJobRecord): void {
    const tokenId =
        params.targetKind === TRADING_JOB_TARGET_KIND.Token
            ? params.jobId
            : null;
    db.prepare<{
        jobId: string;
        botKind: TradingBotKind;
        chainId: number;
        collectionId: number;
        status: TradingJobStatus;
        targetKind: TradingJobTargetKind;
        tokenId: string | null;
    }>(
        "INSERT INTO trading_jobs " +
            "(job_id, bot_kind, chain_id, collection_id, status, target_kind, token_id) " +
            "VALUES (@jobId, @botKind, @chainId, @collectionId, @status, @targetKind, @tokenId)",
    ).run({
        jobId: params.jobId,
        botKind: params.botKind ?? TRADING_BOT_KIND.Bidding,
        chainId: params.chainId,
        collectionId: params.collectionId,
        status: params.status ?? TRADING_JOB_STATUS.Enabled,
        targetKind: params.targetKind,
        tokenId,
    });
}

function seedJob(
    params: SeedJobRecord & {
        ceilingWei: string;
    },
): void {
    seedJobRecord(params);
    db.prepare<{
        jobId: string;
        ceilingWei: string;
    }>(
        "INSERT INTO trading_bidding_job_specs " +
            "(job_id, floor_wei, ceiling_wei, delta_wei, quantity) " +
            "VALUES (@jobId, '1', @ceilingWei, '1', 1)",
    ).run({ jobId: params.jobId, ceilingWei: params.ceilingWei });
}

describe("SqliteBiddingJobCeilingPrefillsRead", () => {
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });

    it("returns exact enabled and paused maxima across every bidding scope in one chain", () => {
        const firstCollectionId = seedCollection({
            chainId: 1,
            slug: "first",
            address: "0x1111111111111111111111111111111111111111",
        });
        const secondCollectionId = seedCollection({
            chainId: 1,
            slug: "second",
            address: "0x2222222222222222222222222222222222222222",
        });
        const otherChainCollectionId = seedCollection({
            chainId: 10,
            slug: "other-chain",
            address: "0x3333333333333333333333333333333333333333",
        });

        seedJob({
            jobId: "token-nine",
            chainId: 1,
            collectionId: firstCollectionId,
            targetKind: TRADING_JOB_TARGET_KIND.Token,
            ceilingWei: "9000000000000000000",
        });
        seedJob({
            jobId: "collection-ten",
            chainId: 1,
            collectionId: firstCollectionId,
            targetKind: TRADING_JOB_TARGET_KIND.Collection,
            ceilingWei: "10000000000000000000",
        });
        seedJob({
            jobId: "trait-twelve",
            chainId: 1,
            collectionId: firstCollectionId,
            targetKind: TRADING_JOB_TARGET_KIND.CompetitiveTrait,
            ceilingWei: "12000000000000000000",
        });
        seedJob({
            jobId: "paused-higher",
            chainId: 1,
            collectionId: firstCollectionId,
            status: TRADING_JOB_STATUS.Paused,
            targetKind: TRADING_JOB_TARGET_KIND.Token,
            ceilingWei: "99000000000000000000",
        });
        seedJob({
            jobId: "archived-higher",
            chainId: 1,
            collectionId: firstCollectionId,
            status: TRADING_JOB_STATUS.Archived,
            targetKind: TRADING_JOB_TARGET_KIND.Token,
            ceilingWei: "100000000000000000000",
        });
        seedJob({
            jobId: "sniping-higher",
            chainId: 1,
            collectionId: firstCollectionId,
            botKind: TRADING_BOT_KIND.Sniping,
            targetKind: TRADING_JOB_TARGET_KIND.Collection,
            ceilingWei: "101000000000000000000",
        });
        seedJob({
            jobId: "second-paused-only",
            chainId: 1,
            collectionId: secondCollectionId,
            status: TRADING_JOB_STATUS.Paused,
            targetKind: TRADING_JOB_TARGET_KIND.Collection,
            ceilingWei: "5000000000000000000",
        });
        seedJob({
            jobId: "other-chain-higher",
            chainId: 10,
            collectionId: otherChainCollectionId,
            targetKind: TRADING_JOB_TARGET_KIND.Collection,
            ceilingWei: "102000000000000000000",
        });

        const repository = new SqliteBiddingJobCeilingPrefillsRead();

        assert.deepEqual(repository.listCeilingPrefillMaxima({ chainId: 1 }), [
            {
                collectionId: firstCollectionId,
                maxCeilingWei: "99000000000000000000",
            },
            {
                collectionId: secondCollectionId,
                maxCeilingWei: "5000000000000000000",
            },
        ]);
    });

    it("omits archived-only collections and current jobs without bidding specs", () => {
        const archivedOnlyCollectionId = seedCollection({
            chainId: 1,
            slug: "archived-only",
            address: "0x4444444444444444444444444444444444444444",
        });
        const missingSpecCollectionId = seedCollection({
            chainId: 1,
            slug: "missing-spec",
            address: "0x5555555555555555555555555555555555555555",
        });
        seedJob({
            jobId: "archived-only",
            chainId: 1,
            collectionId: archivedOnlyCollectionId,
            status: TRADING_JOB_STATUS.Archived,
            targetKind: TRADING_JOB_TARGET_KIND.Collection,
            ceilingWei: "1000000000000000000",
        });
        seedJobRecord({
            jobId: "enabled-without-spec",
            chainId: 1,
            collectionId: missingSpecCollectionId,
            targetKind: TRADING_JOB_TARGET_KIND.Collection,
        });

        assert.deepEqual(
            new SqliteBiddingJobCeilingPrefillsRead().listCeilingPrefillMaxima({
                chainId: 1,
            }),
            [],
        );
    });

    it.each([TRADING_JOB_STATUS.Enabled, TRADING_JOB_STATUS.Paused])(
        "fails closed when a %s ceiling is not canonical positive wei",
        (status) => {
            const collectionId = seedCollection({
                chainId: 1,
                slug: "invalid-ceiling",
                address: "0x4444444444444444444444444444444444444444",
            });
            seedJob({
                jobId: "invalid",
                chainId: 1,
                collectionId,
                status,
                targetKind: TRADING_JOB_TARGET_KIND.Token,
                ceilingWei: "01",
            });

            assert.throws(
                () =>
                    new SqliteBiddingJobCeilingPrefillsRead().listCeilingPrefillMaxima(
                        {
                            chainId: 1,
                        },
                    ),
                /invalid ceiling_wei/,
            );
        },
    );

    it("uses covering job lookup and spec primary-key indexes without a table scan", () => {
        const plan = db.raw
            .prepare(`EXPLAIN QUERY PLAN ${BIDDING_JOB_CEILING_PREFILLS_SQL}`)
            .all({
                chainId: 1,
                botKind: TRADING_BOT_KIND.Bidding,
                enabledStatus: TRADING_JOB_STATUS.Enabled,
                pausedStatus: TRADING_JOB_STATUS.Paused,
            }) as Array<{ detail: string }>;
        const detail = plan.map((row) => row.detail).join("\n");

        assert.match(detail, /trading_jobs_chain_bot_status_collection_idx/);
        assert.match(detail, /sqlite_autoindex_trading_bidding_job_specs_1/);
        assert.doesNotMatch(detail, /SCAN j(?:\s|$)/);
        assert.doesNotMatch(detail, /USE TEMP B-TREE/);
    });
});
