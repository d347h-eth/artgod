import {
    BIDDING_SERVICE_REQUEST_PRIORITY,
    BIDDING_ORDER_RECOVERY_STATUS,
    BiddingService,
    type Order,
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
    placedAt: string | null;
    expirationTimeMs: number | null;
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
        retryCutoff: string;
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
    cancellationRetryMs: number;
    dryRun: boolean;
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
    RetryFailed: "failedCancellationRetryFailed",
    RetrySkippedDryRun: "failedCancellationRetrySkippedDryRun",
    RetrySkippedExpired: "failedCancellationRetrySkippedExpired",
    RetryStarted: "failedCancellationRetryStarted",
    RetrySucceeded: "failedCancellationRetrySucceeded",
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
            retryCutoff: new Date(
                Date.now() - this.config.cancellationRetryMs,
            ).toISOString(),
        });
        let completedCount = 0;

        for (const record of records) {
            try {
                // Recover remote state before deciding whether local completion or a live retry is safe.
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
                    if (this.config.dryRun) {
                        await this.restoreTerminalFailureIfAvailable(record);
                        log.debug(
                            FAILED_OFFER_CANCELLATION_RECONCILER_LOG_ACTION.RetrySkippedDryRun,
                            "Skipping failed cancellation retry in dry-run mode",
                            {
                                jobId: record.jobId,
                                orderId: record.orderId,
                                collectionSlug: record.collectionSlug,
                            },
                        );
                    } else if (this.shouldRetryCancellation(record)) {
                        const didComplete = await this.retryActiveCancellation(
                            record,
                            result.order,
                        );
                        if (didComplete) {
                            completedCount += 1;
                        }
                        continue;
                    } else {
                        await this.restoreTerminalFailureIfAvailable(record);
                        log.debug(
                            FAILED_OFFER_CANCELLATION_RECONCILER_LOG_ACTION.RetrySkippedExpired,
                            "Skipping failed cancellation retry because the offer is past its stored expiration",
                            {
                                jobId: record.jobId,
                                orderId: record.orderId,
                                collectionSlug: record.collectionSlug,
                                expirationTimeMs: record.expirationTimeMs,
                            },
                        );
                    }

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

    private shouldRetryCancellation(
        record: RecoverableOfferCancellationRecord,
    ): boolean {
        return (
            record.expirationTimeMs === null ||
            record.expirationTimeMs > Date.now()
        );
    }

    private async retryActiveCancellation(
        record: RecoverableOfferCancellationRecord,
        recoveredOrder: Order,
    ): Promise<boolean> {
        const order = this.mergeRecoveredOrder(record, recoveredOrder);
        log.info(
            FAILED_OFFER_CANCELLATION_RECONCILER_LOG_ACTION.RetryStarted,
            "Retrying failed offer cancellation",
            {
                jobId: record.jobId,
                orderId: record.orderId,
                collectionSlug: record.collectionSlug,
                expirationTimeMs: record.expirationTimeMs,
            },
        );

        try {
            // Retry only in live mode after OpenSea proved the tracked order is active.
            await this.biddingService.cancelRecoveredOrder(order, {
                priority: BIDDING_SERVICE_REQUEST_PRIORITY.Background,
            });
            const completedAt = new Date().toISOString();
            await this.repository.markOfferCancellationCompleted({
                jobId: record.jobId,
                orderId: record.orderId,
                completedAt,
            });
            log.info(
                FAILED_OFFER_CANCELLATION_RECONCILER_LOG_ACTION.RetrySucceeded,
                "Retried failed offer cancellation successfully",
                {
                    jobId: record.jobId,
                    orderId: record.orderId,
                    collectionSlug: record.collectionSlug,
                },
            );
            return true;
        } catch (error) {
            const cancellationError =
                error instanceof Error ? error.message : String(error);
            await this.repository.markOfferCancellationFailed({
                jobId: record.jobId,
                orderId: record.orderId,
                cancellationError,
            });
            log.warn(
                FAILED_OFFER_CANCELLATION_RECONCILER_LOG_ACTION.RetryFailed,
                "Failed to retry offer cancellation",
                {
                    jobId: record.jobId,
                    orderId: record.orderId,
                    collectionSlug: record.collectionSlug,
                    ...toErrorLogFields(error),
                },
            );
            return false;
        }
    }

    private mergeRecoveredOrder(
        record: RecoverableOfferCancellationRecord,
        recoveredOrder: Order,
    ): Order {
        return {
            ...recoveredOrder,
            protocolAddress:
                recoveredOrder.protocolAddress ??
                record.protocolAddress ??
                undefined,
            placedAt: recoveredOrder.placedAt ?? record.placedAt ?? undefined,
            expirationTime:
                recoveredOrder.expirationTime ??
                (record.expirationTimeMs === null
                    ? undefined
                    : Math.floor(record.expirationTimeMs / 1000)),
        };
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
