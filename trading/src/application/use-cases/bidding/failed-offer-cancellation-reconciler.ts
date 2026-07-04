import {
    BIDDING_ORDER_RECOVERY_STATUS,
    BiddingService,
} from "./bidding-service.js";
import {
    BIDDING_LOG_COMPONENT,
    createBiddingComponentLogger,
    toErrorLogFields,
} from "../../../utils/bidding-log.js";

export type RecoverableOfferCancellationRecord = {
    jobId: string;
    orderId: string;
    protocolAddress: string | null;
    collectionAddress: string;
    collectionSlug: string;
    tokenId: string | null;
    cancellationError: string | null;
    terminalCommandError: string | null;
    hasTerminalCommand: boolean;
};

export type CompletedOfferCancellation = {
    jobId: string;
    orderId: string;
    completedAt: string;
};

export interface FailedOfferCancellationRepositoryPort {
    listRecoverableOfferCancellations(params: {
        chainId: number;
        limit: number;
    }):
        | Promise<RecoverableOfferCancellationRecord[]>
        | RecoverableOfferCancellationRecord[];
    markOfferCancellationCompleted(
        cancellation: CompletedOfferCancellation,
    ): Promise<void> | void;
    markOfferCancellationFailed(params: {
        jobId: string;
        orderId: string;
        cancellationError: string;
    }): Promise<void> | void;
}

export type FailedOfferCancellationReconcilerConfig = {
    chainId: number;
    batchSize: number;
};

const log = createBiddingComponentLogger(
    BIDDING_LOG_COMPONENT.BiddingFailedCancellationReconciler,
);

// Stored when a terminal cancel command left no success or failure fact on the cancellation row.
export const UNSETTLED_TERMINAL_CANCELLATION_ERROR =
    "Cancellation command finished before the offer cancellation was settled";

// Log actions owned by the failed-cancellation recovery use case.
export const FAILED_OFFER_CANCELLATION_RECONCILER_LOG_ACTION = {
    Recovered: "failedCancellationRecovered",
    FailureRestored: "failedCancellationFailureRestored",
    StillActive: "failedCancellationStillActive",
    Inconclusive: "failedCancellationRecoveryInconclusive",
    Failed: "failedCancellationRecoveryFailed",
} as const;

// FailedOfferCancellationReconciler heals failed cancellation rows only after OpenSea proves the order is gone.
export class FailedOfferCancellationReconciler {
    constructor(
        private readonly repository: FailedOfferCancellationRepositoryPort,
        private readonly biddingService: BiddingService,
        private readonly config: FailedOfferCancellationReconcilerConfig,
    ) {}

    async reconcileFailedCancellations(): Promise<number> {
        const records = await this.repository.listRecoverableOfferCancellations({
            chainId: this.config.chainId,
            limit: this.config.batchSize,
        });
        let completedCount = 0;

        for (const record of records) {
            try {
                const result = await this.biddingService.getOrder(
                    record.orderId,
                    record.protocolAddress ?? undefined,
                    record.collectionAddress,
                    record.tokenId ?? undefined,
                    record.collectionSlug,
                );

                if (
                    result.status ===
                    BIDDING_ORDER_RECOVERY_STATUS.InactiveOrMissing
                ) {
                    const completedAt = new Date().toISOString();
                    await this.repository.markOfferCancellationCompleted({
                        jobId: record.jobId,
                        orderId: record.orderId,
                        completedAt,
                    });
                    completedCount += 1;
                    log.info(
                        FAILED_OFFER_CANCELLATION_RECONCILER_LOG_ACTION.Recovered,
                        "Recovered failed offer cancellation as completed",
                        {
                            jobId: record.jobId,
                            orderId: record.orderId,
                            collectionSlug: record.collectionSlug,
                        },
                    );
                    continue;
                }

                if (result.status === BIDDING_ORDER_RECOVERY_STATUS.Active) {
                    await this.restoreTerminalFailureIfAvailable(record);
                    log.debug(
                        FAILED_OFFER_CANCELLATION_RECONCILER_LOG_ACTION.StillActive,
                        "Failed offer cancellation still has an active order",
                        {
                            jobId: record.jobId,
                            orderId: record.orderId,
                            collectionSlug: record.collectionSlug,
                        },
                    );
                    continue;
                }

                await this.restoreTerminalFailureIfAvailable(record);
                log.debug(
                    FAILED_OFFER_CANCELLATION_RECONCILER_LOG_ACTION.Inconclusive,
                    "Failed offer cancellation recovery was inconclusive",
                    {
                        jobId: record.jobId,
                        orderId: record.orderId,
                        collectionSlug: record.collectionSlug,
                        reason: result.reason,
                    },
                );
            } catch (error) {
                log.warn(
                    FAILED_OFFER_CANCELLATION_RECONCILER_LOG_ACTION.Failed,
                    "Failed to reconcile failed offer cancellation",
                    {
                        jobId: record.jobId,
                        orderId: record.orderId,
                        collectionSlug: record.collectionSlug,
                        ...toErrorLogFields(error),
                    },
                );
            }
        }

        return completedCount;
    }

    private async restoreTerminalFailureIfAvailable(
        record: RecoverableOfferCancellationRecord,
    ): Promise<void> {
        if (record.cancellationError || !record.hasTerminalCommand) {
            return;
        }

        await this.repository.markOfferCancellationFailed({
            jobId: record.jobId,
            orderId: record.orderId,
            cancellationError:
                record.terminalCommandError ??
                UNSETTLED_TERMINAL_CANCELLATION_ERROR,
        });
        log.warn(
            FAILED_OFFER_CANCELLATION_RECONCILER_LOG_ACTION.FailureRestored,
            "Restored terminal cancellation failure for unresolved offer cancellation",
            {
                jobId: record.jobId,
                orderId: record.orderId,
                collectionSlug: record.collectionSlug,
            },
        );
    }
}
