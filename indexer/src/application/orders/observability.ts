import type { MAKER_REVALIDATION_STEP_END } from "../../domain/maker-revalidation.js";
import type { MakerValidationBatch } from "../../ports/order-validation.js";
import type {
    ProcessingObservability,
    ProcessingObserver,
} from "../processing-observability.js";
import type { OrderValidationBatchReport } from "./validate-order-demand.js";

/** Stable operation names shared by APM spans and bounded metric labels. */
export const ORDER_PROCESSING_OPERATION = {
    ValidationWait: "orders.validationAdmission.wait",
    DemandAdmit: "orders.validationDemand.admit",
    DemandClaim: "orders.validationDemand.claim",
    DemandBatch: "orders.validationDemand.batch",
    DemandSnapshot: "orders.validationDemand.snapshot",
    DemandValidate: "orders.validationDemand.validate",
    DemandVerify: "orders.validationDemand.verify",
    DemandCommit: "orders.validationDemand.commit",
    Lifecycle: "orders.lifecycle.apply",
    MakerAdmit: "orders.maker.admit",
    MakerStep: "orders.maker.step",
    MakerSnapshot: "orders.maker.snapshot",
    MakerValidate: "orders.maker.validate",
    MakerVerify: "orders.maker.verify",
    MakerCheckpoint: "orders.maker.checkpoint",
    MakerRecovery: "orders.maker.recover",
    MakerWakeup: "orders.maker.recoverWakeup",
    MakerCleanup: "orders.maker.cleanup",
} as const;

export const ORDER_VALIDATION_BATCH_OUTCOME = {
    Scanned: "scanned",
    Claimed: "claimed",
    Validated: "validated",
    Applied: "applied",
    Covered: "covered",
    ResolvedUnneeded: "resolvedUnneeded",
    Followup: "followup",
    Retried: "retried",
    Released: "released",
    LostClaims: "lostClaims",
} as const satisfies Record<string, keyof OrderValidationBatchReport>;
export const ORDER_VALIDATION_BATCH_COUNTERS = Object.values(
    ORDER_VALIDATION_BATCH_OUTCOME,
);

export const ORDER_VALIDATION_PATH = {
    Demand: "demand",
    Maker: "maker",
} as const;
export type OrderValidationPath =
    (typeof ORDER_VALIDATION_PATH)[keyof typeof ORDER_VALIDATION_PATH];

export type MakerCheckpointReport = {
    resolved: number;
    deferred: number;
    validated: number;
    stepEnd: (typeof MAKER_REVALIDATION_STEP_END)[keyof typeof MAKER_REVALIDATION_STEP_END];
};

/** Counts are observations of bounded work, not global table inventories. */
export interface OrderProcessingObserver extends ProcessingObserver {
    demandBatch(report: OrderValidationBatchReport, nowMs: number): void;
    makerCheckpoint(report: MakerCheckpointReport): void;
    contractReads(
        path: OrderValidationPath,
        reads: ReturnType<MakerValidationBatch["readCounts"]>,
    ): void;
    makerRecovery(checked: number, recovered: number, failed: number): void;
    makerReceiptsCleaned(count: number): void;
}

export type OrderProcessingObservability = ProcessingObservability & {
    observer?: OrderProcessingObserver;
};
