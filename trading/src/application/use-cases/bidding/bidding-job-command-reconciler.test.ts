import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import {
    TRADING_JOB_COMMAND_KIND,
    TRADING_JOB_COMMAND_STATUS,
    TRADING_JOB_STATUS,
    type TradingJobStatus,
} from "@artgod/shared/types";
import type { BidderJob } from "../../../domain/market/strategy/job.js";
import { Bidder } from "./bidder.js";
import type { BiddingService, Order } from "./bidding-service.js";
import type {
    BiddingJobCommand,
    BiddingJobCommandRepository,
} from "./bidding-job-command-repository.js";
import { BiddingJobCommandReconciler } from "./bidding-job-command-reconciler.js";
import type {
    BiddingJobSource,
    BiddingJobSourceRecord,
} from "./bidding-job-source.js";

const makerAddress = "0x00000000000000000000000000000000000000aa";

function makeJob(jobId: string): BidderJob {
    return {
        id: jobId,
        network: "eth",
        collectionAddress: "0x1111111111111111111111111111111111111111",
        collectionSlug: "terraforms",
        target: {
            type: "token",
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
): BiddingJobCommand {
    return {
        commandId,
        jobId,
        commandKind,
        status: TRADING_JOB_COMMAND_STATUS.Processing,
        requestedRevision: 1,
        payload: { jobId },
        attempts: 1,
    };
}

class FakeCommandRepository implements BiddingJobCommandRepository {
    completed: number[] = [];
    retryFailures: Array<{ commandId: number; error: string }> = [];
    terminalFailures: Array<{ commandId: number; error: string }> = [];

    constructor(private readonly commands: BiddingJobCommand[]) {}

    async claimNextBatch(): Promise<BiddingJobCommand[]> {
        return this.commands.splice(0);
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

    constructor(private readonly offers: Order[] = []) {}

    async getActiveOffers(): Promise<Order[]> {
        return this.offers;
    }

    async getActiveTokenOfferByMaker(): Promise<Order | null> {
        return null;
    }

    async getOrder(): Promise<Order | null> {
        return null;
    }

    async placeOffer(): Promise<{
        orderHash: string;
        protocolAddress: string;
        expirationTime?: number;
    }> {
        return {
            orderHash: "0xplaced",
            protocolAddress: "0x00000000006c3852cbef3e08e8df289169ede581",
        };
    }

    async cancelOffer(_job: BidderJob, order: Order): Promise<void> {
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
        revision: 1,
    };
}

describe("BiddingJobCommandReconciler", () => {
    it("loads enabled job commands, prepares runtime dependencies, and refreshes the bidder", async () => {
        const job = makeJob("job-enabled");
        const repository = new FakeCommandRepository([
            makeCommand(
                1,
                job.id,
                TRADING_JOB_COMMAND_KIND.JobUpdated,
            ),
        ]);
        const source = new FakeJobSource(
            new Map([[job.id, makeRecord(job, TRADING_JOB_STATUS.Enabled)]]),
        );
        const biddingService = new FakeBiddingService();
        const bidder = new Bidder(biddingService, makerAddress, 60_000, {
            dryRun: true,
        });
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

        const processed = await reconciler.processPendingCommands("test");

        assert.equal(processed, 1);
        assert.equal(bidder.getJob(job.id)?.id, job.id);
        assert.deepEqual(prepared, [job.id]);
        assert.deepEqual(reconciled, [[job.id]]);
        assert.deepEqual(repository.completed, [1]);
    });

    it("removes disabled jobs from scheduling and cancels maker offers through the bidder", async () => {
        const job = makeJob("job-paused");
        const repository = new FakeCommandRepository([
            makeCommand(1, job.id, TRADING_JOB_COMMAND_KIND.JobPaused),
            makeCommand(2, job.id, TRADING_JOB_COMMAND_KIND.CancelActiveOffer),
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

        const processed = await reconciler.processPendingCommands("test");

        assert.equal(processed, 2);
        assert.equal(bidder.getJob(job.id), undefined);
        assert.deepEqual(biddingService.cancelled, ["0xactive"]);
        assert.deepEqual(reconciled, [[], []]);
        assert.deepEqual(repository.completed, [1, 2]);
    });
});
