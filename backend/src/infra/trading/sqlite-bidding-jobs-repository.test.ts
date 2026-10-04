import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { zeroAddress } from "viem";
import { beforeEach, describe, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND } from "@artgod/shared/extensions";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { SqliteCollectionsReadModel } from "@artgod/shared/read-models/collections";
import {
    TOKEN_ATTRIBUTE_SOURCE_KIND,
    TOKEN_ATTRIBUTE_METADATA_SOURCE_KEY,
} from "@artgod/shared/types/token-attributes";
import type { TraitBiddingTargetSupportReadPort } from "../../application/use-cases/trading/trait-bidding-target.js";
import {
    COLLECTION_STANDARD,
    COLLECTION_STATUS,
    TRADING_BIDDING_JOB_RUNTIME_BID_POSITION,
    TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT,
    TRADING_BIDDING_JOB_PRICING_SOURCE_KIND,
    TRADING_BOT_KIND,
    TRADING_BOT_RUNTIME_STATE,
    TRADING_JOB_COMMAND_KIND,
    TRADING_JOB_STATUS,
    TRADING_JOB_TARGET_KIND,
    type TradingBiddingJobRuntimeBidPosition,
    type TradingBiddingJobRuntimeConstraint,
} from "@artgod/shared/types";
import { SqliteBiddingCompetitionPresetsRepository } from "./sqlite-bidding-competition-presets-repository.js";
import { SqliteBiddingJobsRepository } from "./sqlite-bidding-jobs-repository.js";
import { TradingValidationError } from "../../application/use-cases/trading/types.js";
import { BiddingCompetitionPresetReapplyUseCase } from "../../application/use-cases/trading/bidding-competition-preset-reapply.js";

const ACTIVE_ORDER_ID = "0xactive-order";
const ACTIVE_PROTOCOL_ADDRESS = "0x00000000006c3852cbef3e08e8df289169ede581";
const ACTIVE_ORDER_PLACED_AT = "2026-05-17T00:00:00Z";
const ACTIVE_ORDER_VERIFIED_AT = "2026-05-17T00:00:02Z";

// Bidding job persistence tests use a generic collection with a market slug.
const BIDDING_JOBS_FIXTURE_SLUG = "bidding-jobs-fixture";
const BIDDING_JOBS_FIXTURE_OPENSEA_SLUG = "bidding-jobs-fixture-opensea";

async function createTempDbPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "artgod-bidding-jobs-"));
    return join(dir, "main.sqlite");
}

function seedCollection(): number {
    const result = db
        .prepare<{
            chainId: number;
            slug: string;
            address: string;
            standard: string;
            status: string;
            tokenScopeKind: string;
            openseaSlug: string;
        }>(
            "INSERT INTO collections " +
                "(chain_id, slug, address, standard, status, token_scope_kind, opensea_slug) " +
                "VALUES (@chainId, @slug, @address, @standard, @status, @tokenScopeKind, @openseaSlug)",
        )
        .run({
            chainId: 1,
            slug: BIDDING_JOBS_FIXTURE_SLUG,
            address: "0x1111111111111111111111111111111111111111",
            standard: COLLECTION_STANDARD.Erc721,
            status: COLLECTION_STATUS.Live,
            tokenScopeKind:
                EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.AllContractTokens,
            openseaSlug: BIDDING_JOBS_FIXTURE_OPENSEA_SLUG,
        });

    return Number(result.lastInsertRowid);
}

describe("SqliteBiddingJobsRepository", () => {
    let collectionId = 0;

    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        const migrationRunner = createMigrationRunner();
        await migrationRunner.runMigrations();
        collectionId = seedCollection();
    });

    function seedReapply() {
        const repository = new SqliteBiddingJobsRepository();
        const presets = new SqliteBiddingCompetitionPresetsRepository();
        const scope = { chainId: 1, collectionId };
        const v1 = presets.savePreset({
            ...scope,
            targetTraits: [{ type: "Zone" }],
            extraCompetitionTraits: [{ type: "Mode" }],
        });
        const jobs = [
            TRADING_JOB_STATUS.Enabled,
            TRADING_JOB_STATUS.Paused,
        ].map(
            (status, index) =>
                repository.upsertCollectionJob({
                    ...scope,
                    status,
                    quantity: index + 1,
                    targetTraits: [
                        { type: "Zone", value: index ? "Elsewhere" : "Kairo" },
                    ],
                    floorWei: "10",
                    ceilingWei: "30",
                    deltaWei: "2",
                    competitionPresetVersionId: v1.versionId,
                    ...(index
                        ? {
                              priceTierId: "tier-base",
                              pricingSource: {
                                  kind: TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.PriceTier,
                                  tierId: "tier-base",
                                  tierName: "base",
                                  resolvedAt: "2026-01-01T00:00:00Z",
                                  resolvedFloorWei: "10",
                                  resolvedCeilingWei: "30",
                                  deltaWei: "2",
                              },
                          }
                        : {}),
                }).job,
        );
        const v2 = presets.savePreset({
            ...scope,
            presetId: v1.presetId,
            expectedRevision: 1,
            targetTraits: v1.targetTraits,
            extraCompetitionTraits: [{ type: "Mode", value: "Terrain" }],
        });
        const input = {
            ...scope,
            presetId: v1.presetId,
            expectedRevision: 2,
            jobs: jobs.map((job) => ({
                jobId: job.jobId,
                expectedRevision: job.revision,
                versionId: v1.versionId,
            })),
            assertTargetSupported: () => {},
        };
        return { repository, presets, scope, v1, v2, jobs, input };
    }

    function reapplyUseCase(
        fixture: ReturnType<typeof seedReapply>,
        supported: (value: string) => boolean = () => true,
        targets?: TraitBiddingTargetSupportReadPort,
    ) {
        const signals: import("@artgod/shared/types").TradingJobCommandRecord[][] =
            [];
        const useCase = new BiddingCompetitionPresetReapplyUseCase(
            1,
            {
                resolveChainRef: () => ({
                    id: 1,
                    type: "evm",
                    publicChainId: 1,
                    slug: "ethereum",
                    name: "Ethereum",
                }),
            },
            {
                resolveCollectionRef: () => ({
                    chainId: 1,
                    collectionId,
                    slug: BIDDING_JOBS_FIXTURE_SLUG,
                    address: "0x1111111111111111111111111111111111111111",
                    standard: COLLECTION_STANDARD.Erc721,
                    status: COLLECTION_STATUS.Live,
                    deploymentBlock: null,
                    bootstrapAnchorBlock: null,
                    createdAt: "",
                    updatedAt: "",
                }),
            },
            fixture.presets,
            fixture.repository,
            targets ?? {
                listMarketplaceBiddingSupportedTraits: ({ traits }) =>
                    traits.filter((trait) => supported(trait.value)),
            },
            {
                publishBiddingJobCommandsChanged: (commands) => {
                    signals.push(commands);
                },
            },
        );
        const input = {
            chainRef: "ethereum",
            collectionRef: BIDDING_JOBS_FIXTURE_SLUG,
            presetId: fixture.v1.presetId,
        };
        return { useCase, input, signals };
    }

    it("previews unavailable targets as ineligible and upgrades only reviewed eligible jobs", () => {
        const fixture = seedReapply();
        const { useCase, input, signals } = reapplyUseCase(
            fixture,
            (value) => value !== "Elsewhere",
        );
        const preview = useCase.previewCompetitionPresetReapply(input);
        assert.equal(preview.jobs.length, 2);
        assert.equal(preview.jobs.filter((row) => row.error).length, 1);
        assert.match(
            preview.jobs.find((row) => row.error)!.error!,
            /Zone=Elsewhere/,
        );
        assert.throws(
            () =>
                useCase.applyCompetitionPresetReapply({
                    ...input,
                    expectedRevision: 2,
                    jobs: fixture.input.jobs,
                }),
            /not available for marketplace bidding/,
        );
        assert.equal(signals.length, 0);
        assert.deepEqual(
            fixture.repository
                .listCollectionJobs(fixture.scope)
                .map((job) => job.revision),
            [1, 1],
        );
        const applied = useCase.applyCompetitionPresetReapply({
            ...input,
            expectedRevision: 2,
            jobs: [fixture.input.jobs[0]],
        });
        assert.equal(applied.jobs.length, 1);
        assert.equal(
            applied.jobs[0].config.competitionPreset?.versionId,
            fixture.v2.versionId,
        );
        assert.equal(signals.length, 1);
        assert.equal(
            signals[0][0].commandKind,
            TRADING_JOB_COMMAND_KIND.JobUpdated,
        );
    });

    it("previews current versions as unchanged and excludes archived and unrelated jobs", () => {
        const fixture = seedReapply();
        fixture.repository.reapplyCompetitionPreset({
            ...fixture.input,
            jobs: [fixture.input.jobs[0]],
        });
        fixture.repository.archiveJobById({
            ...fixture.scope,
            jobId: fixture.jobs[1].jobId,
        });
        fixture.repository.upsertCollectionJob({
            ...fixture.scope,
            status: TRADING_JOB_STATUS.Enabled,
            quantity: 1,
            targetTraits: [{ type: "Mode", value: "Terrain" }],
            floorWei: "1",
            ceilingWei: "2",
            deltaWei: "1",
        });
        const { useCase, input } = reapplyUseCase(fixture);
        const preview = useCase.previewCompetitionPresetReapply(input);
        assert.equal(preview.jobs.length, 1);
        assert.equal(preview.jobs[0].changed, false);
        assert.equal(preview.jobs[0].error, null);
    });

    it("rejects the whole reapply when another writer revokes target support after preflight", async () => {
        const fixture = seedReapply();
        const address = "0x1111111111111111111111111111111111111111";
        db.prepare(
            "INSERT INTO tokens (chain_id, collection_id, contract_address, token_id) VALUES (?, ?, ?, ?)",
        ).run(1, collectionId, address, "1");
        const keyId = Number(
            db
                .prepare(
                    "INSERT INTO attribute_keys (chain_id, collection_id, contract_address, key) VALUES (?, ?, ?, ?)",
                )
                .run(1, collectionId, address, "Zone").lastInsertRowid,
        );
        for (const value of ["Kairo", "Elsewhere"]) {
            const attributeId = Number(
                db
                    .prepare(
                        "INSERT INTO attributes (chain_id, collection_id, contract_address, attribute_key_id, value) VALUES (?, ?, ?, ?, ?)",
                    )
                    .run(1, collectionId, address, keyId, value)
                    .lastInsertRowid,
            );
            db.prepare(
                "INSERT INTO token_attributes (chain_id, collection_id, contract_address, token_id, attribute_id, source_kind, source_key) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ).run(
                1,
                collectionId,
                address,
                "1",
                attributeId,
                TOKEN_ATTRIBUTE_SOURCE_KIND.Metadata,
                TOKEN_ATTRIBUTE_METADATA_SOURCE_KEY,
            );
        }
        seedBiddingJobRuntimeState({
            jobId: fixture.jobs[1].jobId,
            currentPriceWei: "20",
            activeOrderId: ACTIVE_ORDER_ID,
            bidPosition: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
            bidConstraints: [],
            competitorPriceWei: "25",
        });
        seedBiddingBotRuntimeState();
        const targets = new SqliteCollectionsReadModel([zeroAddress]);
        const { useCase, input, signals } = reapplyUseCase(
            fixture,
            () => true,
            targets,
        );
        assert.ok(
            useCase
                .previewCompetitionPresetReapply(input)
                .jobs.every((row) => row.error === null),
        );
        const before = fixture.repository.listCollectionJobs(fixture.scope);
        const commands = fixture.repository.listPendingCommands({ limit: 100 });
        const worker = new Worker(
            new URL(
                "./test-fixtures/revoke-target-support.mjs",
                import.meta.url,
            ),
            {
                workerData: {
                    dbPath: db.raw.name,
                    ...fixture.scope,
                    key: "Zone",
                    value: "Kairo",
                },
            },
        );
        const completion = once(worker, "exit").then(
            (result) => result,
            (error) => [error],
        );
        const originalWrite = fixture.repository.reapplyCompetitionPreset.bind(
            fixture.repository,
        );
        const write = vi
            .spyOn(fixture.repository, "reapplyCompetitionPreset")
            .mockImplementation((selection) => {
                // Preflight has read the committed metadata while the other writer
                // holds its lock. Let it revoke support before our writer acquires it.
                worker.postMessage(null);
                return originalWrite(selection);
            });
        try {
            await once(worker, "message");
            assert.throws(
                () =>
                    useCase.applyCompetitionPresetReapply({
                        ...input,
                        expectedRevision: 2,
                        // Exercise rollback of the paused job's commands/cancellation
                        // before the later enabled job fails its support check.
                        jobs: [...fixture.input.jobs].reverse(),
                    }),
                /not available for marketplace bidding: Zone=Kairo/,
            );
            assert.deepEqual(await completion, [0]);
            assert.deepEqual(
                fixture.repository.listCollectionJobs(fixture.scope),
                before,
            );
            assert.deepEqual(
                fixture.repository.listPendingCommands({ limit: 100 }),
                commands,
            );
            assert.equal(selectCancellationRequest(ACTIVE_ORDER_ID), undefined);
            assert.equal(signals.length, 0);
            assert.equal(
                useCase
                    .previewCompetitionPresetReapply(input)
                    .jobs.filter((row) => row.error).length,
                1,
            );
        } finally {
            write.mockRestore();
            await worker.terminate();
        }
    });

    it("rejects jobs from another preset, scope or pinned version without changing the batch", () => {
        const fixture = seedReapply();
        const other = fixture.presets.savePreset({
            ...fixture.scope,
            targetTraits: fixture.v1.targetTraits,
            extraCompetitionTraits: fixture.v1.extraCompetitionTraits,
        });
        const otherJob = fixture.repository.upsertCollectionJob({
            ...fixture.scope,
            status: TRADING_JOB_STATUS.Enabled,
            quantity: 5,
            targetTraits: fixture.jobs[0].targetTraits,
            floorWei: "1",
            ceilingWei: "2",
            deltaWei: "1",
            competitionPresetVersionId: other.versionId,
        }).job;
        const before = fixture.repository.listCollectionJobs(fixture.scope);
        const commands = fixture.repository.listPendingCommands({ limit: 100 });
        for (const input of [
            { ...fixture.input, collectionId: collectionId + 1 },
            {
                ...fixture.input,
                jobs: [
                    {
                        ...fixture.input.jobs[0],
                        versionId: fixture.v2.versionId,
                    },
                ],
            },
            {
                ...fixture.input,
                jobs: [
                    fixture.input.jobs[0],
                    {
                        jobId: otherJob.jobId,
                        expectedRevision: otherJob.revision,
                        versionId: other.versionId,
                    },
                ],
            },
        ])
            assert.throws(
                () => fixture.repository.reapplyCompetitionPreset(input),
                TradingValidationError,
            );
        assert.deepEqual(
            fixture.repository.listCollectionJobs(fixture.scope),
            before,
        );
        assert.deepEqual(
            fixture.repository.listPendingCommands({ limit: 100 }),
            commands,
        );
    });

    it("reapplies pinned versions with normal commands, preserving pricing, targets and status", () => {
        const { repository, scope, v1, v2, jobs, input } = seedReapply();
        const token = repository.upsertTokenJob({
            ...scope,
            tokenId: "123",
            status: TRADING_JOB_STATUS.Enabled,
            floorWei: "1",
            ceilingWei: "2",
            deltaWei: "1",
        }).job;
        seedBiddingJobRuntimeState({
            jobId: jobs[1].jobId,
            currentPriceWei: "20",
            activeOrderId: ACTIVE_ORDER_ID,
            bidPosition: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
            bidConstraints: [],
            competitorPriceWei: "25",
        });
        seedBiddingBotRuntimeState();
        const before = jobs.map((job) => repository.getJobById(job.jobId)!);
        const result = repository.reapplyCompetitionPreset(input);
        expectSameDeclarations();
        function expectSameDeclarations() {
            result.jobs.forEach((job, index) => {
                const prior = before[index];
                assert.equal(job.jobId, prior.jobId);
                assert.equal(job.revision, prior.revision + 1);
                assert.equal(job.status, prior.status);
                assert.equal(job.floorWei, prior.floorWei);
                assert.equal(job.ceilingWei, prior.ceilingWei);
                assert.equal(job.deltaWei, prior.deltaWei);
                assert.equal(job.priceTierId, prior.priceTierId);
                assert.deepEqual(job.pricingSource, prior.pricingSource);
                assert.deepEqual(job.targetTraits, jobs[index].targetTraits);
                assert.equal(job.quantity, jobs[index].quantity);
                assert.equal(job.competitionPreset?.versionId, v2.versionId);
            });
        }
        assert.deepEqual(
            result.commands.map((command) => command.commandKind),
            [
                TRADING_JOB_COMMAND_KIND.JobUpdated,
                TRADING_JOB_COMMAND_KIND.CancelActiveOffer,
                TRADING_JOB_COMMAND_KIND.JobPaused,
            ],
        );
        assert.equal(result.commands[1].payload.activeOrderId, ACTIVE_ORDER_ID);
        assert.equal(
            result.commands[1].payload.activeOrderJobRevision,
            jobs[1].revision,
        );
        assert.equal(
            result.commands[1].payload.activeProtocolAddress,
            ACTIVE_PROTOCOL_ADDRESS,
        );
        assert.equal(
            result.commands[1].requestedRevision,
            jobs[1].revision + 1,
        );
        assert.equal(
            selectCancellationRequest(ACTIVE_ORDER_ID)?.job_revision,
            jobs[1].revision,
        );
        assert.deepEqual(repository.getJobById(token.jobId), token);
        assert.equal(
            repository.listCompetitionPresetJobs({
                ...scope,
                presetId: v1.presetId,
            }).length,
            2,
        );
    });

    it("rolls back the whole batch when a later selected job has changed", () => {
        const { repository, scope, jobs, input } = seedReapply();
        repository.upsertCollectionJob({
            ...scope,
            status: jobs[1].status as typeof TRADING_JOB_STATUS.Paused,
            quantity: jobs[1].quantity,
            targetTraits: jobs[1].targetTraits,
            floorWei: "12",
            ceilingWei: "30",
            deltaWei: "2",
        });
        const before = repository.listCollectionJobs(scope);
        const commands = repository.listPendingCommands({ limit: 100 });
        assert.throws(
            () => repository.reapplyCompetitionPreset(input),
            /Selected jobs changed/,
        );
        assert.deepEqual(repository.listCollectionJobs(scope), before);
        assert.deepEqual(
            repository.listPendingCommands({ limit: 100 }),
            commands,
        );
    });

    it("rejects a changed or archived preset inside the write transaction", () => {
        const { repository, presets, scope, v2, input } = seedReapply();
        const v3 = presets.savePreset({
            ...scope,
            presetId: v2.presetId,
            expectedRevision: 2,
            targetTraits: v2.targetTraits,
            extraCompetitionTraits: v2.extraCompetitionTraits,
        });
        const before = repository.listCollectionJobs(scope);
        const commands = repository.listPendingCommands({ limit: 100 });
        assert.throws(
            () => repository.reapplyCompetitionPreset(input),
            /preset changed/,
        );
        presets.archivePreset({
            ...scope,
            presetId: v3.presetId,
            expectedRevision: 3,
        });
        assert.throws(
            () =>
                repository.reapplyCompetitionPreset({
                    ...input,
                    expectedRevision: 3,
                }),
            /preset is unavailable/,
        );
        assert.deepEqual(repository.listCollectionJobs(scope), before);
        assert.deepEqual(
            repository.listPendingCommands({ limit: 100 }),
            commands,
        );
    });

    it("rolls back references, revisions, cancellation records and commands if command insertion fails", () => {
        const { repository, scope, jobs, input } = seedReapply();
        seedBiddingJobRuntimeState({
            jobId: jobs[1].jobId,
            currentPriceWei: "20",
            activeOrderId: ACTIVE_ORDER_ID,
            bidPosition: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
            bidConstraints: [],
            competitorPriceWei: "25",
        });
        seedBiddingBotRuntimeState();
        const before = repository.listCollectionJobs(scope);
        const commands = repository.listPendingCommands({ limit: 100 });
        db.exec(
            "CREATE TRIGGER reject_reapply_command BEFORE INSERT ON trading_job_commands WHEN NEW.command_kind = 'job_paused' BEGIN SELECT RAISE(ABORT, 'command insert failed'); END",
        );
        assert.throws(
            () => repository.reapplyCompetitionPreset(input),
            /command insert failed/,
        );
        assert.deepEqual(repository.listCollectionJobs(scope), before);
        assert.deepEqual(
            repository.listPendingCommands({ limit: 100 }),
            commands,
        );
        assert.equal(selectCancellationRequest(ACTIVE_ORDER_ID), undefined);
    });

    it("creates a token bidding job and emits a job_created outbox row", () => {
        const repository = new SqliteBiddingJobsRepository();

        const result = repository.upsertTokenJob({
            chainId: 1,
            collectionId,
            tokenId: "123",
            status: TRADING_JOB_STATUS.Enabled,
            floorWei: "100000000000000000",
            ceilingWei: "200000000000000000",
            deltaWei: "1000000000000000",
        });

        assert.equal(result.job.targetKind, TRADING_JOB_TARGET_KIND.Token);
        assert.equal(result.job.collectionSlug, BIDDING_JOBS_FIXTURE_SLUG);
        assert.equal(
            result.job.collectionOpenseaSlug,
            BIDDING_JOBS_FIXTURE_OPENSEA_SLUG,
        );
        assert.equal(
            result.job.collectionAddress,
            "0x1111111111111111111111111111111111111111",
        );
        assert.equal(result.job.tokenId, "123");
        assert.equal(result.job.priceTierId, null);
        assert.deepEqual(result.job.pricingSource, {
            kind: TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.Manual,
        });
        assert.equal(result.job.revision, 1);
        assert.equal(result.job.runtime, null);

        assert.equal(result.commands.length, 1);
        assert.equal(
            result.commands[0]?.commandKind,
            TRADING_JOB_COMMAND_KIND.JobCreated,
        );
        assert.equal(result.commands[0]?.requestedRevision, 1);
        assert.match(result.commands[0]?.createdAt ?? "", /\.\d{3}$/);

        const listed = repository.listCollectionJobs({
            chainId: 1,
            collectionId,
        });
        assert.equal(listed.length, 1);
        assert.equal(listed[0]?.jobId, result.job.jobId);

        const loaded = repository.getTokenJob({
            chainId: 1,
            collectionId,
            tokenId: "123",
        });
        assert.equal(loaded?.jobId, result.job.jobId);

        const pendingCommands = repository.listPendingCommands({ limit: 10 });
        assert.equal(pendingCommands.length, 1);
        assert.equal(
            pendingCommands[0]?.commandKind,
            TRADING_JOB_COMMAND_KIND.JobCreated,
        );
    });

    it("shares wildcard preset references across exact job targets and rejects other key combinations", () => {
        const repository = new SqliteBiddingJobsRepository();
        const presets = new SqliteBiddingCompetitionPresetsRepository();
        const input = {
            chainId: 1,
            collectionId,
            status: TRADING_JOB_STATUS.Enabled,
            floorWei: "1",
            ceilingWei: "10",
            deltaWei: "1",
            quantity: 1,
        };
        const preset = presets.savePreset({
            ...input,
            targetTraits: [
                { type: "Mode", value: "Terrain" },
                { type: "Zone" },
            ],
            extraCompetitionTraits: [{ type: "Biome" }],
        });
        for (const value of ["Kairo", "Elsewhere"]) {
            const targetTraits = [
                { type: "Mode", value: "Terrain" },
                { type: "Zone", value },
            ];
            const created = repository.upsertCollectionJob({
                ...input,
                targetTraits,
                competitionPresetVersionId: preset.versionId,
            });
            assert.deepEqual(created.job.targetTraits, targetTraits);
            assert.equal(
                created.job.competitionPreset?.versionId,
                preset.versionId,
            );
            assert.deepEqual(
                repository.getJobById(created.job.jobId),
                created.job,
            );
        }
        for (const targetTraits of [
            [{ type: "Mode", value: "Terrain" }],
            [
                { type: "Mode", value: "Daydream" },
                { type: "Zone", value: "Kairo" },
            ],
            [
                { type: "Mode", value: "Terrain" },
                { type: "Biome", value: "42" },
            ],
        ])
            assert.throws(() =>
                repository.upsertCollectionJob({
                    ...input,
                    targetTraits,
                    competitionPresetVersionId: preset.versionId,
                }),
            );
        assert.equal(repository.listCollectionJobs(input).length, 2);
        assert.equal(repository.listPendingCommands({ limit: 10 }).length, 2);
    });

    it("rejects source changes atomically while allowing extras-only revisions", () => {
        const repository = new SqliteBiddingJobsRepository();
        const presets = new SqliteBiddingCompetitionPresetsRepository();
        const scope = { chainId: 1, collectionId };
        const v1 = presets.savePreset({
            ...scope,
            targetTraits: [
                { type: "Mode", value: "Terrain" },
                { type: "Zone" },
            ],
            extraCompetitionTraits: [{ type: "Biome" }],
        });
        const created = repository.upsertCollectionJob({
            ...scope,
            status: TRADING_JOB_STATUS.Enabled,
            floorWei: "1",
            ceilingWei: "10",
            deltaWei: "1",
            quantity: 1,
            targetTraits: [
                { type: "Mode", value: "Terrain" },
                { type: "Zone", value: "Kairo" },
            ],
            competitionPresetVersionId: v1.versionId,
        });
        const versions = () =>
            db
                .prepare(
                    "SELECT * FROM trading_bidding_competition_preset_versions ORDER BY revision",
                )
                .all();
        const beforeVersions = versions();
        const beforeCommands = repository.listPendingCommands({ limit: 10 });
        for (const targetTraits of [
            [{ type: "Mode", value: "Daydream" }, { type: "Zone" }],
            [{ type: "Mode" }, { type: "Zone" }],
            [{ type: "Mode", value: "Terrain" }, { type: "Biome" }],
            [
                { type: "Mode", value: "Terrain" },
                { type: "Zone", value: "any" },
            ],
            [{ type: "Zone" }],
        ]) {
            assert.throws(
                () =>
                    presets.savePreset({
                        ...scope,
                        presetId: v1.presetId,
                        expectedRevision: 1,
                        targetTraits,
                        extraCompetitionTraits: [{ type: "Chroma" }],
                    }),
                TradingValidationError,
            );
            assert.deepEqual(presets.listPresets(scope), [v1]);
            assert.deepEqual(versions(), beforeVersions);
            assert.deepEqual(
                repository.getJobById(created.job.jobId),
                created.job,
            );
            assert.deepEqual(
                repository.listPendingCommands({ limit: 10 }),
                beforeCommands,
            );
        }
        const v2 = presets.savePreset({
            ...scope,
            presetId: v1.presetId,
            expectedRevision: 1,
            targetTraits: [
                { type: " Zone " },
                { type: "Mode", value: " Terrain " },
            ],
            extraCompetitionTraits: [{ type: "Chroma" }],
        });
        assert.equal(v2.revision, 2);
        assert.deepEqual(v2.targetTraits, v1.targetTraits);
        assert.deepEqual(v2.extraCompetitionTraits, [{ type: "Chroma" }]);
        assert.equal(versions().length, 2);
        assert.deepEqual(versions()[0], beforeVersions[0]);
        assert.deepEqual(repository.getJobById(created.job.jobId), created.job);
        assert.deepEqual(
            repository.listPendingCommands({ limit: 10 }),
            beforeCommands,
        );
    });

    it("pins immutable preset versions and preserves the reference through pricing edits", () => {
        const repository = new SqliteBiddingJobsRepository();
        const presets = new SqliteBiddingCompetitionPresetsRepository();
        const input = {
            chainId: 1,
            collectionId,
            status: TRADING_JOB_STATUS.Enabled,
            floorWei: "1",
            ceilingWei: "10",
            deltaWei: "1",
            quantity: 1,
            targetTraits: [{ type: "Zone", value: "Kairo" }],
        };
        const v1 = presets.savePreset({
            ...input,
            extraCompetitionTraits: [{ type: "Mode" }],
        });
        const created = repository.upsertCollectionJob({
            ...input,
            competitionPresetVersionId: v1.versionId,
        });
        assert.deepEqual(created.job.competitionPreset, {
            versionId: v1.versionId,
            presetId: v1.presetId,
            revision: 1,
            targetTraits: v1.targetTraits,
            extraCompetitionTraits: v1.extraCompetitionTraits,
        });
        const v2 = presets.savePreset({
            ...input,
            presetId: v1.presetId,
            expectedRevision: 1,
            extraCompetitionTraits: [{ type: "Mode", value: "Terrain" }],
        });
        assert.deepEqual(repository.getJobById(created.job.jobId), created.job);
        const edited = repository.upsertCollectionJob({
            ...input,
            ceilingWei: "12",
        });
        assert.deepEqual(
            edited.job.competitionPreset,
            created.job.competitionPreset,
        );
        repository.updateJobsPricingById([
            {
                ...input,
                jobId: created.job.jobId,
                priceTierId: null,
                pricingSource: {
                    kind: TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.Manual,
                },
            },
        ]);
        assert.equal(
            (
                repository.getJobById(
                    created.job.jobId,
                ) as import("@artgod/shared/types").PersistedCollectionBiddingJobRecord
            ).competitionPreset?.versionId,
            v1.versionId,
        );
        const upgraded = repository.upsertCollectionJob({
            ...input,
            competitionPresetVersionId: v2.versionId,
        });
        assert.equal(upgraded.job.jobId, created.job.jobId);
        assert.equal(
            upgraded.commands[0].commandKind,
            TRADING_JOB_COMMAND_KIND.JobUpdated,
        );
        assert.equal(
            upgraded.commands[0].requestedRevision,
            upgraded.job.revision,
        );
        assert.equal(upgraded.job.competitionPreset?.versionId, v2.versionId);
        presets.archivePreset({
            ...input,
            presetId: v1.presetId,
            expectedRevision: 2,
        });
        assert.equal(presets.listPresets(input).length, 0);
        assert.deepEqual(
            repository.upsertCollectionJob({
                ...input,
                competitionPresetVersionId: v2.versionId,
            }).job.competitionPreset,
            upgraded.job.competitionPreset,
        );
        assert.equal(
            repository.upsertCollectionJob({
                ...input,
                competitionPresetVersionId: null,
            }).job.competitionPreset,
            null,
        );
        assert.throws(
            () =>
                repository.upsertCollectionJob({
                    ...input,
                    competitionPresetVersionId: v2.versionId,
                }),
            /preset changed/,
        );
    });

    it("rejects foreign collections, targets and stale preset versions without mutating intent or outbox", () => {
        const repository = new SqliteBiddingJobsRepository();
        const presets = new SqliteBiddingCompetitionPresetsRepository();
        const input = {
            chainId: 1,
            collectionId,
            status: TRADING_JOB_STATUS.Enabled,
            floorWei: "1",
            ceilingWei: "10",
            deltaWei: "1",
            quantity: 1,
            targetTraits: [{ type: "Zone", value: "Kairo" }],
        };
        const v1 = presets.savePreset({
            ...input,
            extraCompetitionTraits: [{ type: "Mode" }],
        });
        presets.savePreset({
            ...input,
            presetId: v1.presetId,
            expectedRevision: 1,
            extraCompetitionTraits: [{ type: "Biome" }],
        });
        for (const invalid of [
            { ...input, competitionPresetVersionId: "missing" },
            { ...input, competitionPresetVersionId: v1.versionId },
            {
                ...input,
                competitionPresetVersionId: v1.versionId,
                targetTraits: [],
            },
            { ...input, competitionPresetVersionId: v1.versionId, chainId: 2 },
            {
                ...input,
                competitionPresetVersionId: v1.versionId,
                collectionId: collectionId + 1,
            },
        ])
            assert.throws(() => repository.upsertCollectionJob(invalid));
        assert.equal(repository.listCollectionJobs(input).length, 0);
        assert.equal(repository.listPendingCommands({ limit: 10 }).length, 0);
        assert.throws(
            () =>
                presets.savePreset({
                    ...input,
                    presetId: v1.presetId,
                    expectedRevision: 1,
                    extraCompetitionTraits: [{ type: "Biome" }],
                }),
            /changed/,
        );
    });

    it("rolls back reference and revision changes when command insertion fails", () => {
        const repository = new SqliteBiddingJobsRepository();
        const input = {
            chainId: 1,
            collectionId,
            status: TRADING_JOB_STATUS.Enabled,
            floorWei: "1",
            ceilingWei: "10",
            deltaWei: "1",
            quantity: 1,
            targetTraits: [{ type: "Zone", value: "Kairo" }],
        };
        const preset =
            new SqliteBiddingCompetitionPresetsRepository().savePreset({
                ...input,
                extraCompetitionTraits: [{ type: "Mode" }],
            });
        const created = repository.upsertCollectionJob(input);
        db.exec(
            "CREATE TRIGGER reject_command BEFORE INSERT ON trading_job_commands BEGIN SELECT RAISE(ABORT, 'fixture command failure'); END",
        );
        assert.throws(
            () =>
                repository.upsertCollectionJob({
                    ...input,
                    competitionPresetVersionId: preset.versionId,
                }),
            /fixture command failure/,
        );
        assert.deepEqual(repository.getJobById(created.job.jobId), created.job);
    });

    it("upgrades pre-feature declarations and validates the manual rollback of the superseded migration", async () => {
        const repository = new SqliteBiddingJobsRepository();
        const created = repository.upsertCollectionJob({
            chainId: 1,
            collectionId,
            status: TRADING_JOB_STATUS.Enabled,
            floorWei: "1",
            ceilingWei: "10",
            deltaWei: "1",
            quantity: 1,
            targetTraits: [{ type: "Zone", value: "Kairo" }],
        });
        db.exec(
            "DROP INDEX trading_bidding_job_specs_competition_version_idx; ALTER TABLE trading_bidding_job_specs DROP COLUMN competition_preset_version_id; DROP TABLE trading_bidding_competition_preset_versions; DROP TABLE trading_bidding_competition_presets;",
        );
        db.prepare("DELETE FROM migrations WHERE name = ?").run(
            "062_trait_competition_presets.sql",
        );
        db.exec(
            "ALTER TABLE trading_bidding_job_specs ADD COLUMN extra_competition_traits_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(extra_competition_traits_json) AND json_type(extra_competition_traits_json) = 'array')",
        );
        db.prepare("INSERT INTO migrations (name) VALUES (?)").run(
            "056_trait_bidding_competition.sql",
        );
        db.exec(
            "BEGIN IMMEDIATE; ALTER TABLE trading_bidding_job_specs DROP COLUMN extra_competition_traits_json; DELETE FROM migrations WHERE name = '056_trait_bidding_competition.sql'; COMMIT;",
        );
        await createMigrationRunner().runMigrations();
        await createMigrationRunner().runMigrations();
        assert.deepEqual(
            new SqliteBiddingJobsRepository().getJobById(created.job.jobId),
            created.job,
        );
    });

    it("persists tier-backed pricing metadata beside scalar token job prices", () => {
        const repository = new SqliteBiddingJobsRepository();

        const result = repository.upsertTokenJob({
            chainId: 1,
            collectionId,
            tokenId: "123",
            status: TRADING_JOB_STATUS.Enabled,
            floorWei: "120000000000000000",
            ceilingWei: "150000000000000000",
            deltaWei: "10000000000000000",
            priceTierId: "tier-base",
            pricingSource: {
                kind: TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.PriceTier,
                tierId: "tier-base",
                tierName: "base",
                resolvedAt: "2026-01-01T00:00:00Z",
                resolvedFloorWei: "120000000000000000",
                resolvedCeilingWei: "150000000000000000",
                deltaWei: "10000000000000000",
            },
        });

        assert.equal(result.job.priceTierId, "tier-base");
        assert.deepEqual(result.job.pricingSource, {
            kind: TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.PriceTier,
            tierId: "tier-base",
            tierName: "base",
            resolvedAt: "2026-01-01T00:00:00Z",
            resolvedFloorWei: "120000000000000000",
            resolvedCeilingWei: "150000000000000000",
            deltaWei: "10000000000000000",
        });
    });

    it("reapplies tier-backed pricing by job id and emits a normal update command", () => {
        const repository = new SqliteBiddingJobsRepository();
        const created = repository.upsertTokenJob({
            chainId: 1,
            collectionId,
            tokenId: "123",
            status: TRADING_JOB_STATUS.Enabled,
            floorWei: "120000000000000000",
            ceilingWei: "150000000000000000",
            deltaWei: "10000000000000000",
            priceTierId: "tier-base",
            pricingSource: {
                kind: TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.PriceTier,
                tierId: "tier-base",
                tierName: "base",
                resolvedAt: "2026-01-01T00:00:00Z",
                resolvedFloorWei: "120000000000000000",
                resolvedCeilingWei: "150000000000000000",
                deltaWei: "10000000000000000",
            },
        });
        seedBiddingJobRuntimeState({
            jobId: created.job.jobId,
            currentPriceWei: "140000000000000000",
            activeOrderId: ACTIVE_ORDER_ID,
            bidPosition: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
            bidConstraints: [TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling],
            competitorPriceWei: "200000000000000000",
        });

        const result = repository.updateJobsPricingById([
            {
                chainId: 1,
                collectionId,
                jobId: created.job.jobId,
                floorWei: "130000000000000000",
                ceilingWei: "160000000000000000",
                deltaWei: "10000000000000000",
                priceTierId: "tier-base",
                pricingSource: {
                    kind: TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.PriceTier,
                    tierId: "tier-base",
                    tierName: "base",
                    resolvedAt: "2026-01-02T00:00:00Z",
                    resolvedFloorWei: "130000000000000000",
                    resolvedCeilingWei: "160000000000000000",
                    deltaWei: "10000000000000000",
                },
            },
        ]);

        assert.equal(result.jobs.length, 1);
        assert.equal(result.jobs[0]?.jobId, created.job.jobId);
        assert.equal(result.jobs[0]?.revision, 2);
        assert.equal(result.jobs[0]?.floorWei, "130000000000000000");
        assert.equal(result.jobs[0]?.runtime, null);
        assert.equal(repository.getJobById(created.job.jobId)?.runtime, null);
        assert.deepEqual(result.jobs[0]?.pricingSource, {
            kind: TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.PriceTier,
            tierId: "tier-base",
            tierName: "base",
            resolvedAt: "2026-01-02T00:00:00Z",
            resolvedFloorWei: "130000000000000000",
            resolvedCeilingWei: "160000000000000000",
            deltaWei: "10000000000000000",
        });
        assert.deepEqual(
            result.commands.map((command) => command.commandKind),
            [TRADING_JOB_COMMAND_KIND.JobUpdated],
        );
        assert.equal(result.commands[0]?.requestedRevision, 2);
    });

    it("creates multiple token bidding jobs in one batch transaction", () => {
        const repository = new SqliteBiddingJobsRepository();

        const result = repository.upsertTokenJobs([
            {
                chainId: 1,
                collectionId,
                tokenId: "123",
                status: TRADING_JOB_STATUS.Enabled,
                floorWei: "100000000000000000",
                ceilingWei: "200000000000000000",
                deltaWei: "1000000000000000",
            },
            {
                chainId: 1,
                collectionId,
                tokenId: "456",
                status: TRADING_JOB_STATUS.Enabled,
                floorWei: "100000000000000000",
                ceilingWei: "200000000000000000",
                deltaWei: "1000000000000000",
            },
        ]);

        assert.deepEqual(
            result.jobs.map((job) => job.tokenId),
            ["123", "456"],
        );
        assert.deepEqual(
            result.commands.map((command) => command.commandKind),
            [
                TRADING_JOB_COMMAND_KIND.JobCreated,
                TRADING_JOB_COMMAND_KIND.JobCreated,
            ],
        );
        assert.equal(
            repository.listCollectionJobs({ chainId: 1, collectionId }).length,
            2,
        );
    });

    it("updates an existing token bidding job, preserves job identity, and hides stale runtime by revision", () => {
        const repository = new SqliteBiddingJobsRepository();
        const created = repository.upsertTokenJob({
            chainId: 1,
            collectionId,
            tokenId: "123",
            status: TRADING_JOB_STATUS.Enabled,
            floorWei: "100000000000000000",
            ceilingWei: "200000000000000000",
            deltaWei: "1000000000000000",
        });

        seedBiddingJobRuntimeState({
            jobId: created.job.jobId,
            currentPriceWei: "150000000000000000",
            activeOrderId: ACTIVE_ORDER_ID,
            bidPosition: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
            bidConstraints: [TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling],
            competitorPriceWei: "250000000000000000",
        });
        seedBiddingBotRuntimeState();

        const updated = repository.upsertTokenJob({
            chainId: 1,
            collectionId,
            tokenId: "123",
            status: TRADING_JOB_STATUS.Paused,
            floorWei: "120000000000000000",
            ceilingWei: "240000000000000000",
            deltaWei: "2000000000000000",
        });

        assert.equal(updated.job.jobId, created.job.jobId);
        assert.equal(updated.job.revision, 2);
        assert.equal(updated.job.status, TRADING_JOB_STATUS.Paused);
        assert.equal(updated.job.floorWei, "120000000000000000");
        assert.equal(updated.job.runtime, null);
        assert.equal(repository.getJobById(created.job.jobId)?.runtime, null);
        assert.equal(countRuntimeRows(created.job.jobId), 1);

        assert.equal(updated.commands.length, 2);
        assert.deepEqual(
            updated.commands.map((command) => command.commandKind),
            [
                TRADING_JOB_COMMAND_KIND.CancelActiveOffer,
                TRADING_JOB_COMMAND_KIND.JobPaused,
            ],
        );
        assert.equal(
            updated.commands[0]?.payload.activeOrderId,
            ACTIVE_ORDER_ID,
        );
        assert.equal(updated.commands[0]?.payload.activeOrderJobRevision, 1);
        assert.equal(
            updated.commands[0]?.payload.activeProtocolAddress,
            ACTIVE_PROTOCOL_ADDRESS,
        );
        assert.equal(
            updated.commands[0]?.payload.activeOrderPlacedAt,
            ACTIVE_ORDER_PLACED_AT,
        );
        assert.deepEqual(selectCancellationRequest(ACTIVE_ORDER_ID), {
            order_id: ACTIVE_ORDER_ID,
            job_id: created.job.jobId,
            job_revision: 1,
            maker: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            price_wei: "150000000000000000",
            protocol_address: ACTIVE_PROTOCOL_ADDRESS,
            placed_at: ACTIVE_ORDER_PLACED_AT,
            expiration_time_ms: 1_700_000_000_000,
            completed_at: null,
            cancellation_error: null,
        });
        assert.equal(updated.commands[0]?.requestedRevision, 2);

        const pendingCommands = repository.listPendingCommands({ limit: 10 });
        assert.deepEqual(
            pendingCommands.map((command) => command.commandKind),
            [
                TRADING_JOB_COMMAND_KIND.JobCreated,
                TRADING_JOB_COMMAND_KIND.CancelActiveOffer,
                TRADING_JOB_COMMAND_KIND.JobPaused,
            ],
        );
    });

    it("creates and updates a trait-scoped collection bidding job", () => {
        const repository = new SqliteBiddingJobsRepository();

        const created = repository.upsertCollectionJob({
            chainId: 1,
            collectionId,
            status: TRADING_JOB_STATUS.Enabled,
            floorWei: "100000000000000000",
            ceilingWei: "200000000000000000",
            deltaWei: "1000000000000000",
            quantity: 1,
            targetTraits: [
                { type: "Mode", value: "Terrain" },
                { type: "Biome", value: "42" },
            ],
        });

        assert.equal(
            created.job.targetKind,
            TRADING_JOB_TARGET_KIND.Collection,
        );
        assert.equal(created.job.quantity, 1);
        assert.deepEqual(created.job.targetTraits, [
            { type: "Biome", value: "42" },
            { type: "Mode", value: "Terrain" },
        ]);
        assert.equal(created.commands.length, 1);
        assert.equal(
            created.commands[0]?.commandKind,
            TRADING_JOB_COMMAND_KIND.JobCreated,
        );

        const updated = repository.upsertCollectionJob({
            chainId: 1,
            collectionId,
            status: TRADING_JOB_STATUS.Paused,
            floorWei: "120000000000000000",
            ceilingWei: "240000000000000000",
            deltaWei: "2000000000000000",
            quantity: 1,
            targetTraits: [
                { type: "Biome", value: "42" },
                { type: "Mode", value: "Terrain" },
            ],
        });

        assert.equal(updated.job.jobId, created.job.jobId);
        assert.equal(updated.job.revision, 2);
        assert.equal(updated.job.status, TRADING_JOB_STATUS.Paused);
        assert.equal(updated.job.floorWei, "120000000000000000");
        assert.deepEqual(
            updated.commands.map((command) => command.commandKind),
            [
                TRADING_JOB_COMMAND_KIND.CancelActiveOffer,
                TRADING_JOB_COMMAND_KIND.JobPaused,
            ],
        );

        const listed = repository.listCollectionJobs({
            chainId: 1,
            collectionId,
        });
        assert.equal(listed.length, 1);
        assert.equal(listed[0]?.jobId, created.job.jobId);
    });

    it("hides stale trait job runtime across pause and reactivation on the same target", () => {
        const repository = new SqliteBiddingJobsRepository();

        const created = repository.upsertCollectionJob({
            chainId: 1,
            collectionId,
            status: TRADING_JOB_STATUS.Enabled,
            floorWei: "100000000000000000",
            ceilingWei: "200000000000000000",
            deltaWei: "1000000000000000",
            quantity: 1,
            targetTraits: [
                { type: "Mode", value: "Terrain" },
                { type: "Biome", value: "42" },
            ],
        });
        seedBiddingJobRuntimeState({
            jobId: created.job.jobId,
            currentPriceWei: "150000000000000000",
            activeOrderId: "0xtrait-active-order",
            bidPosition: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
            bidConstraints: [TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling],
            competitorPriceWei: "250000000000000000",
        });

        const paused = repository.upsertCollectionJob({
            chainId: 1,
            collectionId,
            status: TRADING_JOB_STATUS.Paused,
            floorWei: "120000000000000000",
            ceilingWei: "240000000000000000",
            deltaWei: "2000000000000000",
            quantity: 1,
            targetTraits: [
                { type: "Biome", value: "42" },
                { type: "Mode", value: "Terrain" },
            ],
        });

        assert.equal(paused.job.jobId, created.job.jobId);
        assert.equal(paused.job.revision, 2);
        assert.equal(paused.job.runtime, null);
        assert.deepEqual(
            paused.commands.map((command) => command.commandKind),
            [
                TRADING_JOB_COMMAND_KIND.CancelActiveOffer,
                TRADING_JOB_COMMAND_KIND.JobPaused,
            ],
        );
        assert.equal(
            paused.commands[0]?.payload.activeOrderId,
            "0xtrait-active-order",
        );
        assert.equal(repository.getJobById(created.job.jobId)?.runtime, null);
        assert.equal(countRuntimeRows(created.job.jobId), 1);

        const reactivated = repository.upsertCollectionJob({
            chainId: 1,
            collectionId,
            status: TRADING_JOB_STATUS.Enabled,
            floorWei: "130000000000000000",
            ceilingWei: "260000000000000000",
            deltaWei: "3000000000000000",
            quantity: 1,
            targetTraits: [
                { type: "Biome", value: "42" },
                { type: "Mode", value: "Terrain" },
            ],
        });

        assert.equal(reactivated.job.jobId, created.job.jobId);
        assert.equal(reactivated.job.revision, 3);
        assert.equal(reactivated.job.status, TRADING_JOB_STATUS.Enabled);
        assert.equal(reactivated.job.runtime, null);
        assert.deepEqual(
            reactivated.commands.map((command) => command.commandKind),
            [TRADING_JOB_COMMAND_KIND.JobUpdated],
        );

        const listed = repository.listCollectionJobs({
            chainId: 1,
            collectionId,
        });
        assert.equal(listed.length, 1);
        assert.equal(listed[0]?.jobId, created.job.jobId);
        assert.equal(listed[0]?.runtime, null);
        assert.equal(countRuntimeRows(created.job.jobId), 1);
    });

    it("resolves existing jobs by canonical target equivalence", () => {
        const repository = new SqliteBiddingJobsRepository();
        const tokenJob = repository.upsertTokenJob({
            chainId: 1,
            collectionId,
            tokenId: "123",
            status: TRADING_JOB_STATUS.Enabled,
            floorWei: "100000000000000000",
            ceilingWei: "200000000000000000",
            deltaWei: "1000000000000000",
        });
        const traitJob = repository.upsertCollectionJob({
            chainId: 1,
            collectionId,
            status: TRADING_JOB_STATUS.Enabled,
            floorWei: "100000000000000000",
            ceilingWei: "200000000000000000",
            deltaWei: "1000000000000000",
            quantity: 2,
            targetTraits: [
                { type: "Mode", value: "Terrain" },
                { type: "Biome", value: "42" },
            ],
        });

        const foundToken = repository.findJobByTarget({
            chainId: 1,
            collectionId,
            target: {
                targetKind: TRADING_JOB_TARGET_KIND.Token,
                tokenId: "123",
            },
        });
        assert.equal(foundToken?.jobId, tokenJob.job.jobId);

        const foundTrait = repository.findJobByTarget({
            chainId: 1,
            collectionId,
            target: {
                targetKind: TRADING_JOB_TARGET_KIND.Collection,
                quantity: 2,
                targetTraits: [
                    { type: "Biome", value: "42" },
                    { type: "Mode", value: "Terrain" },
                ],
            },
        });
        assert.equal(foundTrait?.jobId, traitJob.job.jobId);

        const wrongQuantity = repository.findJobByTarget({
            chainId: 1,
            collectionId,
            target: {
                targetKind: TRADING_JOB_TARGET_KIND.Collection,
                quantity: 1,
                targetTraits: [
                    { type: "Biome", value: "42" },
                    { type: "Mode", value: "Terrain" },
                ],
            },
        });
        assert.equal(wrongQuantity, null);
    });

    it("archives a collection bidding job by id and emits archive plus cancel commands", () => {
        const repository = new SqliteBiddingJobsRepository();
        const created = repository.upsertCollectionJob({
            chainId: 1,
            collectionId,
            status: TRADING_JOB_STATUS.Enabled,
            floorWei: "100000000000000000",
            ceilingWei: "200000000000000000",
            deltaWei: "1000000000000000",
            quantity: 1,
            targetTraits: [{ type: "Biome", value: "42" }],
        });

        const archived = repository.archiveJobById({
            chainId: 1,
            collectionId,
            jobId: created.job.jobId,
        });

        assert.ok(archived);
        assert.equal(archived?.job.jobId, created.job.jobId);
        assert.equal(archived?.job.status, TRADING_JOB_STATUS.Archived);
        assert.equal(archived?.job.revision, 2);
        assert.deepEqual(
            archived?.commands.map((command) => command.commandKind),
            [
                TRADING_JOB_COMMAND_KIND.CancelActiveOffer,
                TRADING_JOB_COMMAND_KIND.JobArchived,
            ],
        );

        assert.equal(
            repository.findJobByTarget({
                chainId: 1,
                collectionId,
                target: {
                    targetKind: TRADING_JOB_TARGET_KIND.Collection,
                    quantity: 1,
                    targetTraits: [{ type: "Biome", value: "42" }],
                },
            }),
            null,
        );

        const pendingCommands = repository.listPendingCommands({ limit: 10 });
        assert.deepEqual(
            pendingCommands.map((command) => command.commandKind),
            [
                TRADING_JOB_COMMAND_KIND.JobCreated,
                TRADING_JOB_COMMAND_KIND.CancelActiveOffer,
                TRADING_JOB_COMMAND_KIND.JobArchived,
            ],
        );
    });

    it("archives a token bidding job, hides it from active token lookups, and emits archive plus cancel commands", () => {
        const repository = new SqliteBiddingJobsRepository();
        const created = repository.upsertTokenJob({
            chainId: 1,
            collectionId,
            tokenId: "123",
            status: TRADING_JOB_STATUS.Enabled,
            floorWei: "100000000000000000",
            ceilingWei: "200000000000000000",
            deltaWei: "1000000000000000",
        });

        const archived = repository.archiveTokenJob({
            chainId: 1,
            collectionId,
            tokenId: "123",
        });

        assert.ok(archived);
        assert.equal(archived?.job.jobId, created.job.jobId);
        assert.equal(archived?.job.status, TRADING_JOB_STATUS.Archived);
        assert.equal(archived?.job.revision, 2);
        assert.ok(archived?.job.archivedAt);
        assert.deepEqual(
            archived?.commands.map((command) => command.commandKind),
            [
                TRADING_JOB_COMMAND_KIND.CancelActiveOffer,
                TRADING_JOB_COMMAND_KIND.JobArchived,
            ],
        );

        const activeLookup = repository.getTokenJob({
            chainId: 1,
            collectionId,
            tokenId: "123",
        });
        assert.equal(activeLookup, null);

        const archivedLookup = repository.getTokenJob({
            chainId: 1,
            collectionId,
            tokenId: "123",
            includeArchived: true,
        });
        assert.equal(archivedLookup?.status, TRADING_JOB_STATUS.Archived);

        const listed = repository.listCollectionJobs({
            chainId: 1,
            collectionId,
        });
        assert.equal(listed.length, 0);

        const listedIncludingArchived = repository.listCollectionJobs({
            chainId: 1,
            collectionId,
            includeArchived: true,
        });
        assert.equal(listedIncludingArchived.length, 1);
        assert.equal(
            listedIncludingArchived[0]?.status,
            TRADING_JOB_STATUS.Archived,
        );

        const byId = repository.getJobById(created.job.jobId);
        assert.equal(byId?.status, TRADING_JOB_STATUS.Archived);

        const pendingCommands = repository.listPendingCommands({ limit: 10 });
        assert.deepEqual(
            pendingCommands.map((command) => command.commandKind),
            [
                TRADING_JOB_COMMAND_KIND.JobCreated,
                TRADING_JOB_COMMAND_KIND.CancelActiveOffer,
                TRADING_JOB_COMMAND_KIND.JobArchived,
            ],
        );
    });
});

function seedBiddingJobRuntimeState(input: {
    jobId: string;
    jobRevision?: number;
    currentPriceWei: string;
    activeOrderId: string;
    bidPosition: TradingBiddingJobRuntimeBidPosition;
    bidConstraints: TradingBiddingJobRuntimeConstraint[];
    competitorPriceWei: string;
}): void {
    db.prepare<{
        jobId: string;
        jobRevision: number;
        currentPriceWei: string;
        activeOrderId: string;
        activeProtocolAddress: string;
        activeOrderPlacedAt: string;
        activeOrderVerifiedAt: string;
        activeExpirationTimeMs: number;
        bidPosition: string;
        bidConstraintsJson: string;
        competitorPriceWei: string;
        lastRunAt: string;
        lastError: string;
    }>(
        "INSERT INTO trading_bidding_job_runtime_state " +
            "(job_id, job_revision, current_price_wei, active_order_id, active_protocol_address, active_order_placed_at, active_order_verified_at, active_expiration_time_ms, bid_position, bid_constraints_json, competitor_price_wei, last_run_at, last_error) " +
            "VALUES (@jobId, @jobRevision, @currentPriceWei, @activeOrderId, @activeProtocolAddress, @activeOrderPlacedAt, @activeOrderVerifiedAt, @activeExpirationTimeMs, @bidPosition, @bidConstraintsJson, @competitorPriceWei, @lastRunAt, @lastError)",
    ).run({
        jobId: input.jobId,
        jobRevision: input.jobRevision ?? 1,
        currentPriceWei: input.currentPriceWei,
        activeOrderId: input.activeOrderId,
        activeProtocolAddress: ACTIVE_PROTOCOL_ADDRESS,
        activeOrderPlacedAt: ACTIVE_ORDER_PLACED_AT,
        activeOrderVerifiedAt: ACTIVE_ORDER_VERIFIED_AT,
        activeExpirationTimeMs: 1_700_000_000_000,
        bidPosition: input.bidPosition,
        bidConstraintsJson: JSON.stringify(input.bidConstraints),
        competitorPriceWei: input.competitorPriceWei,
        lastRunAt: "2026-04-23T12:00:00.000Z",
        lastError: "none",
    });
}

function seedBiddingBotRuntimeState(): void {
    db.prepare(
        "INSERT INTO trading_bot_runtime_state " +
            "(bot_kind, chain_id, wallet_id, address, state, heartbeat_at, started_at, updated_at, last_error) " +
            "VALUES (@botKind, 1, @walletId, @address, @state, @heartbeatAt, @startedAt, @updatedAt, NULL)",
    ).run({
        botKind: TRADING_BOT_KIND.Bidding,
        walletId: "default",
        address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        state: TRADING_BOT_RUNTIME_STATE.Running,
        heartbeatAt: "2026-05-17T00:00:00Z",
        startedAt: "2026-05-17T00:00:00Z",
        updatedAt: "2026-05-17T00:00:00Z",
    });
}

function selectCancellationRequest(orderId: string):
    | {
          order_id: string;
          job_id: string;
          job_revision: number;
          maker: string;
          price_wei: string;
          protocol_address: string;
          placed_at: string;
          expiration_time_ms: number;
          completed_at: string | null;
          cancellation_error: string | null;
      }
    | undefined {
    return db
        .prepare<{
            orderId: string;
        }>(
            "SELECT order_id, job_id, job_revision, maker, price_wei, protocol_address, placed_at, expiration_time_ms, completed_at, cancellation_error " +
                "FROM trading_bidding_order_cancellations WHERE order_id = @orderId",
        )
        .get({ orderId }) as
        | {
              order_id: string;
              job_id: string;
              job_revision: number;
              maker: string;
              price_wei: string;
              protocol_address: string;
              placed_at: string;
              expiration_time_ms: number;
              completed_at: string | null;
              cancellation_error: string | null;
          }
        | undefined;
}

function countRuntimeRows(jobId: string): number {
    const row = db
        .prepare<{
            jobId: string;
        }>(
            "SELECT COUNT(*) AS count FROM trading_bidding_job_runtime_state WHERE job_id = @jobId",
        )
        .get({ jobId }) as { count: number };
    return row.count;
}
