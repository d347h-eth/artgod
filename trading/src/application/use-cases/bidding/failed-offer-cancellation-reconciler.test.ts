import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import {
    BIDDING_ORDER_RECOVERY_REASON,
    BIDDING_ORDER_RECOVERY_STATUS,
    type BiddingOrderRecoveryResult,
    type BiddingService,
    type Order,
} from "./bidding-service.js";
import {
    FailedOfferCancellationReconciler,
    UNSETTLED_TERMINAL_CANCELLATION_ERROR,
    type CompletedOfferCancellation,
    type RecoverableOfferCancellationRecord,
    type FailedOfferCancellationRepositoryPort,
} from "./failed-offer-cancellation-reconciler.js";

const FAILED_CANCELLATION_RECORD = {
    jobId: "job-token",
    orderId: "0xmine",
    protocolAddress: "0xprotocol",
    collectionAddress: "0xcollection",
    collectionSlug: "terraforms",
    tokenId: "123",
    cancellationError: "OpenSea unavailable",
    terminalCommandError: null,
    hasTerminalCommand: false,
} satisfies RecoverableOfferCancellationRecord;

class FakeFailedCancellationRepository implements FailedOfferCancellationRepositoryPort {
    completed: CompletedOfferCancellation[] = [];

    constructor(private readonly records: RecoverableOfferCancellationRecord[]) {}

    listRecoverableOfferCancellations(params: {
        chainId: number;
        limit: number;
    }): RecoverableOfferCancellationRecord[] {
        assert.equal(params.chainId, 1);
        return this.records.slice(0, params.limit);
    }

    markOfferCancellationCompleted(
        cancellation: CompletedOfferCancellation,
    ): void {
        this.completed.push(cancellation);
    }

    markOfferCancellationFailed(_failure: {
        jobId: string;
        orderId: string;
        cancellationError: string;
    }): void {
        throw new Error("unused");
    }
}

class FakeBiddingService implements BiddingService {
    lookups: RecoverableOfferCancellationRecord[] = [];
    result: BiddingOrderRecoveryResult = {
        status: BIDDING_ORDER_RECOVERY_STATUS.InactiveOrMissing,
    };
    error: Error | null = null;

    async getActiveOffers(): Promise<Order[]> {
        return [];
    }

    async getActiveTokenOfferByMaker(): Promise<Order | null> {
        return null;
    }

    async getOrder(
        orderHash: string,
        protocolAddress?: string,
        collectionAddress?: string,
        tokenId?: string,
        collectionSlug?: string,
    ): Promise<BiddingOrderRecoveryResult> {
        this.lookups.push({
            jobId: FAILED_CANCELLATION_RECORD.jobId,
            orderId: orderHash,
            protocolAddress: protocolAddress ?? null,
            collectionAddress: collectionAddress ?? "",
            collectionSlug: collectionSlug ?? "",
            tokenId: tokenId ?? null,
            cancellationError: FAILED_CANCELLATION_RECORD.cancellationError,
            terminalCommandError:
                FAILED_CANCELLATION_RECORD.terminalCommandError,
            hasTerminalCommand: FAILED_CANCELLATION_RECORD.hasTerminalCommand,
        });
        if (this.error) {
            throw this.error;
        }
        return this.result;
    }

    async placeOffer(): Promise<{
        orderHash: string;
        protocolAddress: string;
        placedAt: string;
        expirationTime?: number;
    }> {
        throw new Error("unused");
    }

    async cancelOffer(): Promise<void> {
        throw new Error("unused");
    }
}

function createReconciler(
    repository: FailedOfferCancellationRepositoryPort,
    biddingService: BiddingService,
): FailedOfferCancellationReconciler {
    return new FailedOfferCancellationReconciler(repository, biddingService, {
        chainId: 1,
        batchSize: 10,
    });
}

describe("FailedOfferCancellationReconciler", () => {
    it("marks failed cancellation completed when OpenSea proves the order is gone", async () => {
        const repository = new FakeFailedCancellationRepository([
            FAILED_CANCELLATION_RECORD,
        ]);
        const biddingService = new FakeBiddingService();
        const reconciler = createReconciler(repository, biddingService);

        const completedCount = await reconciler.reconcileFailedCancellations();

        assert.equal(completedCount, 1);
        assert.equal(repository.completed.length, 1);
        assert.equal(repository.completed[0]?.jobId, "job-token");
        assert.equal(repository.completed[0]?.orderId, "0xmine");
        assert.ok(repository.completed[0]?.completedAt);
        assert.deepEqual(biddingService.lookups, [FAILED_CANCELLATION_RECORD]);
    });

    it("leaves failed cancellation open when OpenSea still shows an active order", async () => {
        const repository = new FakeFailedCancellationRepository([
            FAILED_CANCELLATION_RECORD,
        ]);
        const biddingService = new FakeBiddingService();
        biddingService.result = {
            status: BIDDING_ORDER_RECOVERY_STATUS.Active,
            order: {
                id: "0xmine",
                maker: "0xmaker",
                price: 1n,
                offerScope: "item",
            },
        };
        const reconciler = createReconciler(repository, biddingService);

        const completedCount = await reconciler.reconcileFailedCancellations();

        assert.equal(completedCount, 0);
        assert.deepEqual(repository.completed, []);
    });

    it("restores terminal command failure when an unresolved cancellation has no error", async () => {
        const restoredFailures: Array<{
            jobId: string;
            orderId: string;
            cancellationError: string;
        }> = [];
        const repository = new (class extends FakeFailedCancellationRepository {
            override markOfferCancellationFailed(failure: {
                jobId: string;
                orderId: string;
                cancellationError: string;
            }): void {
                restoredFailures.push(failure);
            }
        })([
            {
                ...FAILED_CANCELLATION_RECORD,
                cancellationError: null,
                terminalCommandError: "Unable to confirm tracked active offer",
                hasTerminalCommand: true,
            },
        ]);
        const biddingService = new FakeBiddingService();
        biddingService.result = {
            status: BIDDING_ORDER_RECOVERY_STATUS.Active,
            order: {
                id: "0xmine",
                maker: "0xmaker",
                price: 1n,
                offerScope: "item",
            },
        };
        const reconciler = createReconciler(repository, biddingService);

        const completedCount = await reconciler.reconcileFailedCancellations();

        assert.equal(completedCount, 0);
        assert.deepEqual(restoredFailures, [
            {
                jobId: "job-token",
                orderId: "0xmine",
                cancellationError: "Unable to confirm tracked active offer",
            },
        ]);
    });

    it("restores a generic failure when a terminal command left the cancellation unsettled", async () => {
        const restoredFailures: Array<{
            jobId: string;
            orderId: string;
            cancellationError: string;
        }> = [];
        const repository = new (class extends FakeFailedCancellationRepository {
            override markOfferCancellationFailed(failure: {
                jobId: string;
                orderId: string;
                cancellationError: string;
            }): void {
                restoredFailures.push(failure);
            }
        })([
            {
                ...FAILED_CANCELLATION_RECORD,
                cancellationError: null,
                terminalCommandError: null,
                hasTerminalCommand: true,
            },
        ]);
        const biddingService = new FakeBiddingService();
        biddingService.result = {
            status: BIDDING_ORDER_RECOVERY_STATUS.Inconclusive,
            reason: BIDDING_ORDER_RECOVERY_REASON.DirectLookupFailed,
        };
        const reconciler = createReconciler(repository, biddingService);

        const completedCount = await reconciler.reconcileFailedCancellations();

        assert.equal(completedCount, 0);
        assert.deepEqual(restoredFailures, [
            {
                jobId: "job-token",
                orderId: "0xmine",
                cancellationError: UNSETTLED_TERMINAL_CANCELLATION_ERROR,
            },
        ]);
    });

    it("leaves failed cancellation open when OpenSea recovery is inconclusive", async () => {
        const repository = new FakeFailedCancellationRepository([
            FAILED_CANCELLATION_RECORD,
        ]);
        const biddingService = new FakeBiddingService();
        biddingService.result = {
            status: BIDDING_ORDER_RECOVERY_STATUS.Inconclusive,
            reason: BIDDING_ORDER_RECOVERY_REASON.DirectLookupFailed,
        };
        const reconciler = createReconciler(repository, biddingService);

        const completedCount = await reconciler.reconcileFailedCancellations();

        assert.equal(completedCount, 0);
        assert.deepEqual(repository.completed, []);
    });

    it("continues after one failed lookup and completes later proven-absent rows", async () => {
        const records = [
            { ...FAILED_CANCELLATION_RECORD, orderId: "0xfirst" },
            { ...FAILED_CANCELLATION_RECORD, orderId: "0xsecond" },
        ];
        const repository = new FakeFailedCancellationRepository(records);
        const biddingService = new FakeBiddingService();
        let callCount = 0;
        biddingService.getOrder = async () => {
            callCount += 1;
            if (callCount === 1) {
                throw new Error("OpenSea unavailable");
            }
            return {
                status: BIDDING_ORDER_RECOVERY_STATUS.InactiveOrMissing,
            };
        };
        const reconciler = createReconciler(repository, biddingService);

        const completedCount = await reconciler.reconcileFailedCancellations();

        assert.equal(completedCount, 1);
        assert.deepEqual(
            repository.completed.map((item) => item.orderId),
            ["0xsecond"],
        );
    });
});
