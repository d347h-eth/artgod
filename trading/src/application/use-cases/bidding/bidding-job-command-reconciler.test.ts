import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import {
    TRADING_JOB_COMMAND_KIND,
    TRADING_JOB_COMMAND_STATUS,
    TRADING_JOB_STATUS,
    type TradingJobStatus,
} from "@artgod/shared/types";
import {
    BIDDER_TARGET_TYPE,
    type BidderJob,
} from "../../../domain/market/strategy/job.js";
import { Bidder } from "./bidder.js";
import { startBiddingCommandReconciliationLoop } from "../../../runtime/bidding-command-reconciliation-loop.js";
import {
    BIDDING_ORDER_RECOVERY_REASON,
    BIDDING_ORDER_RECOVERY_STATUS,
    type BiddingOrderRecoveryResult,
    type BiddingService,
    type Order,
} from "./bidding-service.js";
import type {
    BiddingJobCommand,
    BiddingJobCommandRepository,
} from "./bidding-job-command-repository.js";
import {
    BIDDING_COMMAND_DURABLE_OUTCOME,
    BIDDING_COMMAND_RECONCILIATION_RESULT,
    BIDDING_COMMAND_TRIGGER,
    BiddingJobCommandReconciler,
    type BiddingCommandObservabilityPort,
    type BiddingCommandReconciliationResult,
    type BiddingJobCommandProgress,
} from "./bidding-job-command-reconciler.js";
import type {
    BiddingJobSource,
    BiddingJobSourceRecord,
} from "./bidding-job-source.js";

const makerAddress = "0x00000000000000000000000000000000000000aa";

function makeJob(jobId: string): BidderJob {
    return {
        id: jobId,
        revision: 1,
        network: "eth",
        collectionId: 1,
        collectionAddress: "0x1111111111111111111111111111111111111111",
        collectionSlug: "terraforms",
        target: {
            type: BIDDER_TARGET_TYPE.Token,
            tokenId: "1",
        },
        config: {
            floor: 100000000000000000n,
            ceiling: 200000000000000000n,
            delta: 1000000000000000n,
        },
        state: {},
    };
}

function makeCommand(
    commandId: number,
    jobId: string,
    commandKind: BiddingJobCommand["commandKind"],
    payload: Record<string, unknown> = { jobId },
    attempts = 1,
): BiddingJobCommand {
    return {
        commandId,
        jobId,
        commandKind,
        status: TRADING_JOB_COMMAND_STATUS.Processing,
        requestedRevision: 1,
        payload,
        attempts,
        createdAtMs: Date.parse("2026-07-14T10:00:00Z"),
        claimedAtMs: Date.parse("2026-07-14T10:00:01Z"),
    };
}

class FakeCommandRepository implements BiddingJobCommandRepository {
    completed: number[] = [];
    retryFailures: Array<{ commandId: number; error: string }> = [];
    terminalFailures: Array<{ commandId: number; error: string }> = [];

    constructor(private readonly commands: BiddingJobCommand[]) {}

    async claimNextBatch(params: {
        limit: number;
        claimTimeoutMs: number;
    }): Promise<BiddingJobCommand[]> {
        void params.claimTimeoutMs;
        return this.commands.splice(0, params.limit);
    }

    async markCompleted(commandId: number): Promise<void> {
        this.completed.push(commandId);
    }

    async markFailedRetry(commandId: number, error: string): Promise<void> {
        this.retryFailures.push({ commandId, error });
    }

    async markFailedTerminal(commandId: number, error: string): Promise<void> {
        this.terminalFailures.push({ commandId, error });
    }

    remainingCommandIds(): number[] {
        return this.commands.map((command) => command.commandId);
    }
}

class ThrowAfterFirstClaimCommandRepository extends FakeCommandRepository {
    private claimCalls = 0;

    override async claimNextBatch(params: {
        limit: number;
        claimTimeoutMs: number;
    }): Promise<BiddingJobCommand[]> {
        this.claimCalls += 1;
        if (this.claimCalls > 1) {
            throw new Error("next command claim failed");
        }
        return await super.claimNextBatch(params);
    }
}

class FakeJobSource implements BiddingJobSource {
    constructor(
        private readonly records: Map<string, BiddingJobSourceRecord>,
    ) {}

    async loadEnabledJobs(): Promise<BidderJob[]> {
        return Array.from(this.records.values())
            .filter((record) => record.status === TRADING_JOB_STATUS.Enabled)
            .map((record) => record.job);
    }

    async loadJobById(jobId: string): Promise<BiddingJobSourceRecord | null> {
        return this.records.get(jobId) ?? null;
    }

    async loadEnabledJobById(jobId: string): Promise<BidderJob | null> {
        const record = this.records.get(jobId);
        return record?.status === TRADING_JOB_STATUS.Enabled
            ? record.job
            : null;
    }
}

class FakeBiddingService implements BiddingService {
    cancelled: string[] = [];
    placeError: Error | null = null;
    orderLookupResult: BiddingOrderRecoveryResult = {
        status: BIDDING_ORDER_RECOVERY_STATUS.InactiveOrMissing,
    };
    activeOffersError: Error | null = null;
    activeOfferReads = 0;

    constructor(private readonly offers: Order[] = []) {}

    async getActiveOffers(): Promise<Order[]> {
        this.activeOfferReads++;
        if (this.activeOffersError) {
            throw this.activeOffersError;
        }
        return this.offers;
    }

    async getActiveTokenOfferByMaker(): Promise<Order | null> {
        return null;
    }

    async getOrder(): Promise<BiddingOrderRecoveryResult> {
        return this.orderLookupResult;
    }

    async placeOffer(): Promise<{
        orderHash: string;
        protocolAddress: string;
        placedAt: string;
        expirationTime?: number;
    }> {
        if (this.placeError) {
            throw this.placeError;
        }
        return {
            orderHash: "0xplaced",
            protocolAddress: "0x00000000006c3852cbef3e08e8df289169ede581",
            placedAt: "2026-05-17T00:00:00Z",
        };
    }

    async cancelOffer(_job: BidderJob, order: Order): Promise<void> {
        this.cancelled.push(order.id);
    }

    async cancelRecoveredOrder(order: Order): Promise<void> {
        this.cancelled.push(order.id);
    }
}

function makeRecord(
    job: BidderJob,
    status: TradingJobStatus,
): BiddingJobSourceRecord {
    return {
        job,
        status,
        revision: job.revision,
    };
}

describe("BiddingJobCommandReconciler", () => {
    it.each([
        {
            fail: false,
            attempts: 1,
            reclaimed: false,
            outcome: BIDDING_COMMAND_DURABLE_OUTCOME.Completed,
        },
        {
            fail: true,
            attempts: 1,
            reclaimed: false,
            outcome: BIDDING_COMMAND_DURABLE_OUTCOME.RetryScheduled,
        },
        {
            fail: true,
            attempts: 3,
            reclaimed: false,
            outcome: BIDDING_COMMAND_DURABLE_OUTCOME.FailedTerminal,
        },
        {
            fail: false,
            attempts: 2,
            reclaimed: true,
            outcome: BIDDING_COMMAND_DURABLE_OUTCOME.Completed,
        },
    ])(
        "reports durable $outcome after persistence (reclaimed=$reclaimed)",
        async ({ fail, attempts, reclaimed, outcome }) => {
            const job = makeJob("job");
            const command = {
                ...makeCommand(
                    1,
                    job.id,
                    TRADING_JOB_COMMAND_KIND.JobUpdated,
                    { jobId: job.id },
                    attempts,
                ),
                reclaimed,
            };
            const repository = new FakeCommandRepository([command]);
            const bidder = new Bidder(
                new FakeBiddingService(),
                makerAddress,
                60_000,
                { dryRun: true },
            );
            const outcomes: string[] = [];
            const reconciler = new BiddingJobCommandReconciler(
                repository,
                new FakeJobSource(
                    new Map([
                        [job.id, makeRecord(job, TRADING_JOB_STATUS.Enabled)],
                    ]),
                ),
                bidder,
                {
                    prepareEnabledJob: async () => {
                        if (fail)
                            throw new Error("synthetic preparation failure");
                    },
                    reconcileEnabledJobs: async () => {},
                },
                { batchSize: 1, claimTimeoutMs: 300_000, maxAttempts: 3 },
                undefined,
                {
                    onReconciliationFinished() {},
                    onCommandClaimed() {},
                    onCommandStrategyStarted() {},
                    onCommandFinished() {},
                    onCommandInFlightChanged() {},
                    onCommandDurableOutcome: (value) => {
                        if (
                            value.outcome ===
                            BIDDING_COMMAND_DURABLE_OUTCOME.Completed
                        )
                            assert.deepEqual(repository.completed, [1]);
                        if (
                            value.outcome ===
                            BIDDING_COMMAND_DURABLE_OUTCOME.RetryScheduled
                        )
                            assert.equal(repository.retryFailures.length, 1);
                        if (
                            value.outcome ===
                            BIDDING_COMMAND_DURABLE_OUTCOME.FailedTerminal
                        )
                            assert.equal(repository.terminalFailures.length, 1);
                        outcomes.push(value.outcome);
                    },
                },
            );
            await reconciler.processPendingCommands(
                BIDDING_COMMAND_TRIGGER.Poll,
            );
            assert.deepEqual(outcomes, [
                ...(reclaimed
                    ? [BIDDING_COMMAND_DURABLE_OUTCOME.StaleClaimRecovered]
                    : []),
                outcome,
            ]);
        },
    );

    it("does not claim that a retry was persisted when its durable write fails", async () => {
        const job = makeJob("job");
        const repository = new (class extends FakeCommandRepository {
            override async markFailedRetry(): Promise<void> {
                throw new Error("retry persistence failed");
            }
        })([makeCommand(1, job.id, TRADING_JOB_COMMAND_KIND.JobUpdated)]);
        const outcomes: string[] = [];
        const reconciler = new BiddingJobCommandReconciler(
            repository,
            new FakeJobSource(
                new Map([
                    [job.id, makeRecord(job, TRADING_JOB_STATUS.Enabled)],
                ]),
            ),
            new Bidder(new FakeBiddingService(), makerAddress, 60_000, {
                dryRun: true,
            }),
            {
                prepareEnabledJob: async () => {
                    throw new Error("preparation failed");
                },
                reconcileEnabledJobs: async () => {},
            },
            { batchSize: 1, claimTimeoutMs: 300_000, maxAttempts: 3 },
            undefined,
            {
                onReconciliationFinished() {},
                onCommandClaimed() {},
                onCommandStrategyStarted() {},
                onCommandFinished() {},
                onCommandInFlightChanged() {},
                onCommandDurableOutcome: ({ outcome }) =>
                    outcomes.push(outcome),
            },
        );
        await assert.rejects(
            reconciler.processPendingCommands(BIDDING_COMMAND_TRIGGER.Poll),
            /retry persistence failed/,
        );
        assert.deepEqual(outcomes, []);
    });

    it("finishes the admitted command but leaves later rows pending across poll and queued signal drains", async () => {
        const jobs = [makeJob("first"), makeJob("second")];
        const repository = new FakeCommandRepository(
            jobs.map((job, index) =>
                makeCommand(
                    index + 1,
                    job.id,
                    TRADING_JOB_COMMAND_KIND.JobUpdated,
                ),
            ),
        );
        const source = new FakeJobSource(
            new Map(
                jobs.map((job) => [
                    job.id,
                    makeRecord(job, TRADING_JOB_STATUS.Enabled),
                ]),
            ),
        );
        const bidder = new Bidder(
            new FakeBiddingService(),
            makerAddress,
            60_000,
            { dryRun: true },
        );
        let admitted!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => {
            admitted = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const results: BiddingCommandReconciliationResult[] = [];
        const reconciler = new BiddingJobCommandReconciler(
            repository,
            source,
            bidder,
            {
                async prepareEnabledJob() {
                    admitted();
                    await gate;
                },
                async reconcileEnabledJobs() {},
            },
            { batchSize: 10, claimTimeoutMs: 300_000, maxAttempts: 3 },
            undefined,
            {
                onReconciliationFinished: (input) => results.push(input.result),
                onCommandClaimed: () => {},
                onCommandStrategyStarted: () => {},
                onCommandFinished: () => {},
                onCommandInFlightChanged: () => {},
            },
        );
        const loop = startBiddingCommandReconciliationLoop(reconciler, 1);
        try {
            await started;
            const queuedSignals = [
                reconciler.processPendingCommands(
                    BIDDING_COMMAND_TRIGGER.Signal,
                ),
                reconciler.processPendingCommands(
                    BIDDING_COMMAND_TRIGGER.Signal,
                ),
            ];
            bidder.closeBackgroundRefreshAdmission();
            reconciler.closeAdmission();
            reconciler.closeAdmission(); // Idempotent Stop must not affect the admitted command.
            const drain = loop.shutdown();
            release();
            await drain;
            assert.deepEqual(await Promise.all(queuedSignals), [0, 0]);
            assert.deepEqual(repository.completed, [1]);
            assert.deepEqual(repository.remainingCommandIds(), [2]);
            assert.equal(bidder.getJob(jobs[1]!.id), undefined);
            assert.deepEqual(
                results,
                Array(3).fill(BIDDING_COMMAND_RECONCILIATION_RESULT.Stopped),
            );
            assert.equal(
                await reconciler.processPendingCommands(
                    BIDDING_COMMAND_TRIGGER.Poll,
                ),
                0,
            );
            assert.deepEqual(repository.remainingCommandIds(), [2]);
        } finally {
            release();
            await loop.shutdown();
            await bidder.stop();
        }
    });

    it("loads enabled job commands, prepares runtime dependencies, and refreshes the bidder", async () => {
        const job = makeJob("job-enabled");
        const command = makeCommand(
            1,
            job.id,
            TRADING_JOB_COMMAND_KIND.JobUpdated,
        );
        const nowMs = Date.now();
        command.createdAtMs = nowMs - 2_500;
        command.claimedAtMs = nowMs - 500;
        const repository = new FakeCommandRepository([command]);
        const source = new FakeJobSource(
            new Map([[job.id, makeRecord(job, TRADING_JOB_STATUS.Enabled)]]),
        );
        const biddingService = new FakeBiddingService();
        const bidder = new Bidder(biddingService, makerAddress, 60_000, {
            dryRun: true,
        });
        const prepared: string[] = [];
        const reconciled: string[][] = [];
        const queueWaits: number[] = [];
        const strategyLatencies: Array<{
            claimToStrategyMs: number;
            createdToStrategyMs: number;
        }> = [];
        const inFlight: number[] = [];
        const observability: BiddingCommandObservabilityPort = {
            onReconciliationFinished: () => undefined,
            onCommandClaimed: (input) => queueWaits.push(input.queueWaitMs),
            onCommandStrategyStarted: (input) => strategyLatencies.push(input),
            onCommandFinished: () => undefined,
            onCommandInFlightChanged: (count) => inFlight.push(count),
        };
        const reconciler = new BiddingJobCommandReconciler(
            repository,
            source,
            bidder,
            {
                prepareEnabledJob: async (preparedJob) => {
                    prepared.push(preparedJob.id);
                },
                reconcileEnabledJobs: async (jobs) => {
                    reconciled.push(jobs.map((item) => item.id));
                },
            },
            {
                batchSize: 10,
                claimTimeoutMs: 300_000,
                maxAttempts: 3,
            },
            undefined,
            observability,
        );

        const processed = await reconciler.processPendingCommands(
            BIDDING_COMMAND_TRIGGER.Poll,
        );

        assert.equal(processed, 1);
        assert.equal(bidder.getJob(job.id)?.id, job.id);
        assert.deepEqual(prepared, [job.id]);
        assert.deepEqual(reconciled, [[job.id]]);
        assert.deepEqual(repository.completed, [1]);
        assert.deepEqual(queueWaits, [2_000]);
        assert.equal(strategyLatencies.length, 1);
        assert.ok(strategyLatencies[0]!.claimToStrategyMs >= 500);
        assert.equal(
            strategyLatencies[0]!.createdToStrategyMs -
                strategyLatencies[0]!.claimToStrategyMs,
            2_000,
        );
        assert.deepEqual(inFlight, [0, 1, 0]);
    });

    it("resets command pressure when the finish observer throws", async () => {
        const job = makeJob("job-throwing-finish-observer");
        const repository = new FakeCommandRepository([
            makeCommand(1, job.id, TRADING_JOB_COMMAND_KIND.JobUpdated),
        ]);
        const source = new FakeJobSource(
            new Map([[job.id, makeRecord(job, TRADING_JOB_STATUS.Enabled)]]),
        );
        const bidder = new Bidder(
            new FakeBiddingService(),
            makerAddress,
            60_000,
            { dryRun: true },
        );
        const inFlight: number[] = [];
        const observability: BiddingCommandObservabilityPort = {
            onReconciliationFinished: () => undefined,
            onCommandClaimed: () => undefined,
            onCommandStrategyStarted: () => undefined,
            onCommandFinished: () => {
                throw new Error("finish observer unavailable");
            },
            onCommandInFlightChanged: (count) => inFlight.push(count),
        };
        const reconciler = new BiddingJobCommandReconciler(
            repository,
            source,
            bidder,
            {
                prepareEnabledJob: async () => undefined,
                reconcileEnabledJobs: async () => undefined,
            },
            {
                batchSize: 10,
                claimTimeoutMs: 300_000,
                maxAttempts: 3,
            },
            undefined,
            observability,
        );

        const processed = await reconciler.processPendingCommands(
            BIDDING_COMMAND_TRIGGER.Poll,
        );

        assert.equal(processed, 1);
        assert.deepEqual(repository.completed, [1]);
        assert.deepEqual(inFlight, [0, 1, 0]);
    });

    it("reports command start and finish progress to observers", async () => {
        const job = makeJob("job-observed");
        const command = makeCommand(
            1,
            job.id,
            TRADING_JOB_COMMAND_KIND.JobUpdated,
        );
        const repository = new FakeCommandRepository([command]);
        const source = new FakeJobSource(
            new Map([[job.id, makeRecord(job, TRADING_JOB_STATUS.Enabled)]]),
        );
        const biddingService = new FakeBiddingService();
        const bidder = new Bidder(biddingService, makerAddress, 60_000, {
            dryRun: true,
        });
        const reconciler = new BiddingJobCommandReconciler(
            repository,
            source,
            bidder,
            {
                prepareEnabledJob: async () => undefined,
                reconcileEnabledJobs: async () => undefined,
            },
            {
                batchSize: 10,
                claimTimeoutMs: 300_000,
                maxAttempts: 3,
            },
        );
        const started: BiddingJobCommandProgress[] = [];
        const finished: Array<
            BiddingJobCommandProgress & { succeeded: boolean }
        > = [];

        const processed = await reconciler.processPendingCommands(
            BIDDING_COMMAND_TRIGGER.Poll,
            {
                onCommandStarted: (progress) => {
                    started.push(progress);
                },
                onCommandFinished: (progress) => {
                    finished.push(progress);
                },
            },
        );

        const expectedProgress = {
            trigger: BIDDING_COMMAND_TRIGGER.Poll,
            commandId: command.commandId,
            commandKind: command.commandKind,
            jobId: command.jobId,
            processed: 1,
            batchSize: 10,
        };
        assert.equal(processed, 1);
        assert.deepEqual(started, [expectedProgress]);
        assert.deepEqual(finished, [
            {
                ...expectedProgress,
                succeeded: true,
            },
        ]);
    });

    it("preserves processed batch work when a later command claim fails", async () => {
        const job = makeJob("job-claim-failure-after-work");
        const repository = new ThrowAfterFirstClaimCommandRepository([
            makeCommand(1, job.id, TRADING_JOB_COMMAND_KIND.JobUpdated),
        ]);
        const source = new FakeJobSource(
            new Map([[job.id, makeRecord(job, TRADING_JOB_STATUS.Enabled)]]),
        );
        const bidder = new Bidder(
            new FakeBiddingService(),
            makerAddress,
            60_000,
            { dryRun: true },
        );
        const reconciliations: Array<{
            processed: number;
            result: BiddingCommandReconciliationResult;
        }> = [];
        const reconciler = new BiddingJobCommandReconciler(
            repository,
            source,
            bidder,
            {
                prepareEnabledJob: async () => undefined,
                reconcileEnabledJobs: async () => undefined,
            },
            {
                batchSize: 10,
                claimTimeoutMs: 300_000,
                maxAttempts: 3,
            },
            undefined,
            {
                onReconciliationFinished: ({ processed, result }) => {
                    reconciliations.push({ processed, result });
                },
                onCommandClaimed: () => undefined,
                onCommandStrategyStarted: () => undefined,
                onCommandFinished: () => undefined,
                onCommandInFlightChanged: () => undefined,
            },
        );

        await assert.rejects(
            reconciler.processPendingCommands(BIDDING_COMMAND_TRIGGER.Poll),
            /next command claim failed/,
        );

        assert.deepEqual(repository.completed, [1]);
        assert.deepEqual(reconciliations, [
            {
                processed: 1,
                result: BIDDING_COMMAND_RECONCILIATION_RESULT.Failure,
            },
        ]);
    });

    it("keeps enabled job commands retryable when immediate placement fails", async () => {
        const job = makeJob("job-enabled-place-fails");
        const repository = new FakeCommandRepository([
            makeCommand(1, job.id, TRADING_JOB_COMMAND_KIND.JobUpdated),
        ]);
        const source = new FakeJobSource(
            new Map([[job.id, makeRecord(job, TRADING_JOB_STATUS.Enabled)]]),
        );
        const biddingService = new FakeBiddingService();
        biddingService.placeError = new Error("opensea placement unavailable");
        const bidder = new Bidder(biddingService, makerAddress, 60_000);
        const prepared: string[] = [];
        const reconciled: string[][] = [];
        const reconciliationResults: BiddingCommandReconciliationResult[] = [];
        const observability: BiddingCommandObservabilityPort = {
            onReconciliationFinished: (input) =>
                reconciliationResults.push(input.result),
            onCommandClaimed: () => undefined,
            onCommandStrategyStarted: () => undefined,
            onCommandFinished: () => undefined,
            onCommandInFlightChanged: () => undefined,
        };
        const reconciler = new BiddingJobCommandReconciler(
            repository,
            source,
            bidder,
            {
                prepareEnabledJob: async (preparedJob) => {
                    prepared.push(preparedJob.id);
                },
                reconcileEnabledJobs: async (jobs) => {
                    reconciled.push(jobs.map((item) => item.id));
                },
            },
            {
                batchSize: 10,
                claimTimeoutMs: 300_000,
                maxAttempts: 3,
            },
            undefined,
            observability,
        );

        const processed = await reconciler.processPendingCommands(
            BIDDING_COMMAND_TRIGGER.Poll,
        );

        assert.equal(processed, 1);
        assert.equal(bidder.getJob(job.id)?.id, job.id);
        assert.deepEqual(prepared, [job.id]);
        assert.deepEqual(reconciled, []);
        assert.deepEqual(repository.completed, []);
        assert.equal(repository.retryFailures.length, 1);
        assert.equal(repository.retryFailures[0]?.commandId, 1);
        assert.deepEqual(reconciliationResults, [
            BIDDING_COMMAND_RECONCILIATION_RESULT.CompletedWithFailures,
        ]);
        assert.match(
            repository.retryFailures[0]?.error ?? "",
            /opensea placement unavailable/,
        );
    });

    it("completes enabled job commands without another refresh when current runtime already satisfies the same declaration", async () => {
        const declaredJob = makeJob("job-already-satisfied");
        const liveJob = makeJob(declaredJob.id);
        liveJob.state.activeOrderId = "0xactive";
        liveJob.state.activeOrderVerifiedAt = "2026-05-17T00:00:00Z";
        liveJob.state.currentPrice = 200000000000000000n;
        const repository = new FakeCommandRepository([
            makeCommand(1, declaredJob.id, TRADING_JOB_COMMAND_KIND.JobCreated),
        ]);
        const source = new FakeJobSource(
            new Map([
                [
                    declaredJob.id,
                    makeRecord(declaredJob, TRADING_JOB_STATUS.Enabled),
                ],
            ]),
        );
        const biddingService = new FakeBiddingService();
        const bidder = new Bidder(biddingService, makerAddress, 60_000);
        bidder.addJob(liveJob);
        const prepared: string[] = [];
        const reconciled: string[][] = [];
        const reconciler = new BiddingJobCommandReconciler(
            repository,
            source,
            bidder,
            {
                prepareEnabledJob: async (preparedJob) => {
                    prepared.push(preparedJob.id);
                },
                reconcileEnabledJobs: async (jobs) => {
                    reconciled.push(jobs.map((item) => item.id));
                },
            },
            {
                batchSize: 10,
                claimTimeoutMs: 300_000,
                maxAttempts: 3,
            },
        );

        const processed = await reconciler.processPendingCommands(
            BIDDING_COMMAND_TRIGGER.Poll,
        );

        assert.equal(processed, 1);
        assert.deepEqual(prepared, []);
        assert.equal(biddingService.activeOfferReads, 0);
        assert.deepEqual(reconciled, [[declaredJob.id]]);
        assert.deepEqual(repository.completed, [1]);
    });

    it("cancels maker offers before removing disabled jobs from scheduling", async () => {
        const job = makeJob("job-paused");
        job.state.activeOrderId = "0xactive";
        job.state.activeProtocolAddress =
            "0x00000000006c3852cbef3e08e8df289169ede581";
        const repository = new FakeCommandRepository([
            makeCommand(1, job.id, TRADING_JOB_COMMAND_KIND.CancelActiveOffer),
            makeCommand(2, job.id, TRADING_JOB_COMMAND_KIND.JobPaused),
        ]);
        const source = new FakeJobSource(
            new Map([[job.id, makeRecord(job, TRADING_JOB_STATUS.Paused)]]),
        );
        const biddingService = new FakeBiddingService([
            {
                id: "0xactive",
                maker: makerAddress,
                price: 100000000000000000n,
                protocolAddress: "0x00000000006c3852cbef3e08e8df289169ede581",
                offerScope: "item",
            },
        ]);
        const bidder = new Bidder(biddingService, makerAddress, 60_000);
        bidder.addJob(job);
        const reconciled: string[][] = [];
        const reconciler = new BiddingJobCommandReconciler(
            repository,
            source,
            bidder,
            {
                prepareEnabledJob: async () => undefined,
                reconcileEnabledJobs: async (jobs) => {
                    reconciled.push(jobs.map((item) => item.id));
                },
            },
            {
                batchSize: 10,
                claimTimeoutMs: 300_000,
                maxAttempts: 3,
            },
        );

        const processed = await reconciler.processPendingCommands(
            BIDDING_COMMAND_TRIGGER.Poll,
        );

        assert.equal(processed, 2);
        assert.equal(bidder.getJob(job.id), undefined);
        assert.deepEqual(biddingService.cancelled, ["0xactive"]);
        assert.deepEqual(reconciled, [[], []]);
        assert.deepEqual(repository.completed, [1, 2]);
    });

    it("cancels active offers without unscheduling an enabled job", async () => {
        const job = makeJob("job-enabled-cancel");
        job.state.activeOrderId = "0xactive";
        job.state.activeProtocolAddress =
            "0x00000000006c3852cbef3e08e8df289169ede581";
        const repository = new FakeCommandRepository([
            makeCommand(1, job.id, TRADING_JOB_COMMAND_KIND.CancelActiveOffer),
        ]);
        const source = new FakeJobSource(
            new Map([[job.id, makeRecord(job, TRADING_JOB_STATUS.Enabled)]]),
        );
        const biddingService = new FakeBiddingService([
            {
                id: "0xactive",
                maker: makerAddress,
                price: 100000000000000000n,
                protocolAddress: "0x00000000006c3852cbef3e08e8df289169ede581",
                offerScope: "item",
            },
        ]);
        const bidder = new Bidder(biddingService, makerAddress, 60_000);
        bidder.addJob(job);
        const reconciled: string[][] = [];
        const reconciler = new BiddingJobCommandReconciler(
            repository,
            source,
            bidder,
            {
                prepareEnabledJob: async () => undefined,
                reconcileEnabledJobs: async (jobs) => {
                    reconciled.push(jobs.map((item) => item.id));
                },
            },
            {
                batchSize: 10,
                claimTimeoutMs: 300_000,
                maxAttempts: 3,
            },
        );

        const processed = await reconciler.processPendingCommands(
            BIDDING_COMMAND_TRIGGER.Poll,
        );

        assert.equal(processed, 1);
        assert.equal(bidder.getJob(job.id)?.id, job.id);
        assert.deepEqual(biddingService.cancelled, ["0xactive"]);
        assert.deepEqual(reconciled, [[job.id]]);
        assert.deepEqual(repository.completed, [1]);
    });

    it("stops processing later commands when cancellation needs a retry", async () => {
        const job = makeJob("job-archived");
        job.state.activeOrderId = "0xmissing";
        job.state.activeProtocolAddress =
            "0x00000000006c3852cbef3e08e8df289169ede581";
        const repository = new FakeCommandRepository([
            makeCommand(1, job.id, TRADING_JOB_COMMAND_KIND.CancelActiveOffer),
            makeCommand(2, job.id, TRADING_JOB_COMMAND_KIND.JobArchived),
        ]);
        const source = new FakeJobSource(
            new Map([[job.id, makeRecord(job, TRADING_JOB_STATUS.Archived)]]),
        );
        const biddingService = new FakeBiddingService([]);
        biddingService.activeOffersError = new Error("OpenSea unavailable");
        const bidder = new Bidder(biddingService, makerAddress, 60_000);
        bidder.addJob(job);
        const reconciled: string[][] = [];
        const reconciler = new BiddingJobCommandReconciler(
            repository,
            source,
            bidder,
            {
                prepareEnabledJob: async () => undefined,
                reconcileEnabledJobs: async (jobs) => {
                    reconciled.push(jobs.map((item) => item.id));
                },
            },
            {
                batchSize: 10,
                claimTimeoutMs: 300_000,
                maxAttempts: 3,
            },
        );

        const processed = await reconciler.processPendingCommands(
            BIDDING_COMMAND_TRIGGER.Poll,
        );

        assert.equal(processed, 1);
        assert.equal(bidder.getJob(job.id), undefined);
        assert.deepEqual(biddingService.cancelled, []);
        assert.equal(biddingService.activeOfferReads, 1);
        assert.deepEqual(reconciled, []);
        assert.deepEqual(repository.completed, []);
        assert.equal(repository.retryFailures.length, 1);
        assert.equal(repository.retryFailures[0]?.commandId, 1);
        assert.deepEqual(repository.remainingCommandIds(), [2]);
    });

    it("keeps inconclusive tracked-order cancellation retryable", async () => {
        const job = makeJob("job-archived");
        job.state.activeOrderId = "0xmissing";
        job.state.activeProtocolAddress =
            "0x00000000006c3852cbef3e08e8df289169ede581";
        const repository = new FakeCommandRepository([
            makeCommand(1, job.id, TRADING_JOB_COMMAND_KIND.CancelActiveOffer),
            makeCommand(2, job.id, TRADING_JOB_COMMAND_KIND.JobArchived),
        ]);
        const source = new FakeJobSource(
            new Map([[job.id, makeRecord(job, TRADING_JOB_STATUS.Archived)]]),
        );
        const biddingService = new FakeBiddingService([]);
        biddingService.orderLookupResult = {
            status: BIDDING_ORDER_RECOVERY_STATUS.Inconclusive,
            reason: BIDDING_ORDER_RECOVERY_REASON.DirectLookupFailed,
        };
        const bidder = new Bidder(biddingService, makerAddress, 60_000);
        bidder.addJob(job);
        const reconciler = new BiddingJobCommandReconciler(
            repository,
            source,
            bidder,
            {
                prepareEnabledJob: async () => undefined,
                reconcileEnabledJobs: async () => undefined,
            },
            {
                batchSize: 10,
                claimTimeoutMs: 300_000,
                maxAttempts: 3,
            },
        );

        const processed = await reconciler.processPendingCommands(
            BIDDING_COMMAND_TRIGGER.Poll,
        );

        assert.equal(processed, 1);
        assert.equal(bidder.getJob(job.id), undefined);
        assert.deepEqual(biddingService.cancelled, []);
        assert.deepEqual(repository.completed, []);
        assert.equal(repository.retryFailures.length, 1);
        assert.equal(repository.retryFailures[0]?.commandId, 1);
        assert.deepEqual(repository.remainingCommandIds(), [2]);
    });

    it("records terminal cancellation failures in the cancellation lifecycle", async () => {
        const job = makeJob("job-archived");
        job.state.activeOrderId = "0xactive";
        job.state.activeProtocolAddress =
            "0x00000000006c3852cbef3e08e8df289169ede581";
        const repository = new FakeCommandRepository([
            makeCommand(
                1,
                job.id,
                TRADING_JOB_COMMAND_KIND.CancelActiveOffer,
                {
                    jobId: job.id,
                    activeOrderId: "0xactive",
                    activeProtocolAddress:
                        "0x00000000006c3852cbef3e08e8df289169ede581",
                },
                3,
            ),
        ]);
        const source = new FakeJobSource(
            new Map([[job.id, makeRecord(job, TRADING_JOB_STATUS.Archived)]]),
        );
        const biddingService = new FakeBiddingService([]);
        biddingService.activeOffersError = new Error("OpenSea unavailable");
        const bidder = new Bidder(biddingService, makerAddress, 60_000);
        bidder.addJob(job);
        const failures: Array<{
            jobId: string;
            orderId: string;
            cancellationError: string;
        }> = [];
        const reconciler = new BiddingJobCommandReconciler(
            repository,
            source,
            bidder,
            {
                prepareEnabledJob: async () => undefined,
                reconcileEnabledJobs: async () => undefined,
            },
            {
                batchSize: 10,
                claimTimeoutMs: 300_000,
                maxAttempts: 3,
            },
            {
                markOfferCancellationFailed: async (failure) => {
                    failures.push(failure);
                },
            },
        );

        const processed = await reconciler.processPendingCommands(
            BIDDING_COMMAND_TRIGGER.Poll,
        );

        assert.equal(processed, 1);
        assert.deepEqual(repository.completed, []);
        assert.deepEqual(repository.retryFailures, []);
        assert.deepEqual(repository.terminalFailures, [
            { commandId: 1, error: "OpenSea unavailable" },
        ]);
        assert.deepEqual(failures, [
            {
                jobId: job.id,
                orderId: "0xactive",
                cancellationError: "OpenSea unavailable",
            },
        ]);
    });

    it("treats no-order cancellation as idempotent and continues later commands", async () => {
        const job = makeJob("job-archived-without-order");
        const repository = new FakeCommandRepository([
            makeCommand(1, job.id, TRADING_JOB_COMMAND_KIND.CancelActiveOffer),
            makeCommand(2, job.id, TRADING_JOB_COMMAND_KIND.JobArchived),
        ]);
        const source = new FakeJobSource(
            new Map([[job.id, makeRecord(job, TRADING_JOB_STATUS.Archived)]]),
        );
        const biddingService = new FakeBiddingService([]);
        biddingService.activeOffersError = new Error(
            "Server Error: NFT with identifier unminted-tile-5785 not found in collection terraforms",
        );
        const bidder = new Bidder(biddingService, makerAddress, 60_000);
        bidder.addJob(job);
        const reconciled: string[][] = [];
        const reconciler = new BiddingJobCommandReconciler(
            repository,
            source,
            bidder,
            {
                prepareEnabledJob: async () => undefined,
                reconcileEnabledJobs: async (jobs) => {
                    reconciled.push(jobs.map((item) => item.id));
                },
            },
            {
                batchSize: 10,
                claimTimeoutMs: 300_000,
                maxAttempts: 3,
            },
        );

        const processed = await reconciler.processPendingCommands(
            BIDDING_COMMAND_TRIGGER.Poll,
        );

        assert.equal(processed, 2);
        assert.equal(bidder.getJob(job.id), undefined);
        assert.equal(biddingService.activeOfferReads, 0);
        assert.deepEqual(biddingService.cancelled, []);
        assert.deepEqual(reconciled, [[], []]);
        assert.deepEqual(repository.completed, [1, 2]);
        assert.deepEqual(repository.retryFailures, []);
    });

    it("recovers cancellation state from command payload after the live job is gone", async () => {
        const job = makeJob("job-archived");
        job.revision = 2;
        const repository = new FakeCommandRepository([
            makeCommand(1, job.id, TRADING_JOB_COMMAND_KIND.CancelActiveOffer, {
                jobId: job.id,
                activeOrderJobRevision: 1,
                activeOrderId: "0xactive",
                activeProtocolAddress:
                    "0x00000000006c3852cbef3e08e8df289169ede581",
                activeOrderPlacedAt: "2026-05-17T00:00:00Z",
                currentPriceWei: "100000000000000000",
                activeExpirationTimeMs: 1_700_000_000_000,
            }),
        ]);
        const source = new FakeJobSource(
            new Map([[job.id, makeRecord(job, TRADING_JOB_STATUS.Archived)]]),
        );
        const biddingService = new FakeBiddingService([]);
        biddingService.orderLookupResult = {
            status: BIDDING_ORDER_RECOVERY_STATUS.Active,
            order: {
                id: "0xactive",
                maker: makerAddress,
                price: 100000000000000000n,
                protocolAddress: "0x00000000006c3852cbef3e08e8df289169ede581",
                offerScope: "item",
            },
        };
        const recordedCancellationRevisions: number[] = [];
        const bidder = new Bidder(
            biddingService,
            makerAddress,
            60_000,
            {},
            undefined,
            undefined,
            {
                persistJobRuntimeState: () => undefined,
                recordJobOfferCancellation: (snapshot) => {
                    recordedCancellationRevisions.push(snapshot.jobRevision);
                },
            },
        );
        const reconciled: string[][] = [];
        const reconciler = new BiddingJobCommandReconciler(
            repository,
            source,
            bidder,
            {
                prepareEnabledJob: async () => undefined,
                reconcileEnabledJobs: async (jobs) => {
                    reconciled.push(jobs.map((item) => item.id));
                },
            },
            {
                batchSize: 10,
                claimTimeoutMs: 300_000,
                maxAttempts: 3,
            },
        );

        const processed = await reconciler.processPendingCommands(
            BIDDING_COMMAND_TRIGGER.Poll,
        );

        assert.equal(processed, 1);
        assert.deepEqual(biddingService.cancelled, ["0xactive"]);
        assert.deepEqual(recordedCancellationRevisions, [1, 1]);
        assert.equal(job.revision, 2);
        assert.deepEqual(reconciled, [[]]);
        assert.deepEqual(repository.completed, [1]);
    });
});
