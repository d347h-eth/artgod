import {
    BIDDING_SERVICE_REQUEST_PRIORITY,
    BIDDING_ORDER_RECOVERY_STATUS,
    BiddingService,
    type OrderCancellation,
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

export type OfferCancellationCheck = {
    jobId: string;
    orderId: string;
    now: number;
    retryAt: number;
};

export interface FailedOfferCancellationRepositoryPort {
    listRecoverableOfferCancellations(params: {
        chainId: number;
        limit: number;
        now: number;
        retryCutoff: string;
    }):
        | Promise<RecoverableOfferCancellationRecord[]>
        | RecoverableOfferCancellationRecord[];
    // Advance scheduling before lookup, without changing outcome or display freshness.
    // False means another check already deferred this row, or it completed meanwhile.
    beginOfferCancellationCheck(
        check: OfferCancellationCheck,
    ): Promise<boolean> | boolean;
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
    Unresolved: "failedCancellationUnresolved",
    Failed: "failedCancellationRecoveryFailed",
} as const;

// Completion requires terminal evidence or a successful cancellation; availability is insufficient.
export class FailedOfferCancellationReconciler {
    private acceptingRecords = true;

    constructor(
        private readonly repository: FailedOfferCancellationRepositoryPort,
        private readonly biddingService: BiddingService,
        private readonly config: FailedOfferCancellationReconcilerConfig,
    ) {}

    // An admitted record may settle, but no later record may start after Stop.
    closeAdmission(): void {
        this.acceptingRecords = false;
    }

    async reconcileFailedCancellations(): Promise<number> {
        if (!this.acceptingRecords) return 0;

        const records = await this.repository.listRecoverableOfferCancellations(
            {
                chainId: this.config.chainId,
                limit: this.config.batchSize,
                now: Date.now(),
                retryCutoff: new Date(
                    Date.now() - this.config.cancellationRetryMs,
                ).toISOString(),
            },
        );
        let completedCount = 0;

        for (const record of records) {
            // Recheck after the repository await and between records in the batch.
            if (!this.acceptingRecords) break;

            try {
                const now = Date.now();
                if (
                    !(await this.repository.beginOfferCancellationCheck({
                        jobId: record.jobId,
                        orderId: record.orderId,
                        now,
                        retryAt: now + this.config.cancellationRetryMs,
                    }))
                )
                    continue;
                // Recover remote state before deciding whether local completion or a live retry is safe.
                const result = await this.biddingService.getOrder(
                    record.orderId,
                    record.protocolAddress ?? undefined,
                    record.collectionAddress,
                    record.tokenId ?? undefined,
                    record.collectionSlug,
                );

                if (result.status === BIDDING_ORDER_RECOVERY_STATUS.Terminal) {
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
                    const didComplete = await this.retryCancellation(
                        record,
                        result.status === BIDDING_ORDER_RECOVERY_STATUS.Active
                            ? result.order
                            : { id: record.orderId },
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
                    FAILED_OFFER_CANCELLATION_RECONCILER_LOG_ACTION.Unresolved,
                    "Offer cancellation remains unresolved",
                    {
                        jobId: record.jobId,
                        orderId: record.orderId,
                        collectionSlug: record.collectionSlug,
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

    private async retryCancellation(
        record: RecoverableOfferCancellationRecord,
        recoveredOrder: OrderCancellation,
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
            // A saved cancellation obligation does not depend on present funding or API availability.
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
        recoveredOrder: OrderCancellation,
    ): OrderCancellation {
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
