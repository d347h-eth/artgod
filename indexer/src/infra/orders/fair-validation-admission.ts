import type {
    OrderValidationAdmissionPort,
    OrderValidationAdmissionObserver,
} from "../../ports/order-validation-admission.js";
import { observeBestEffort } from "../../application/processing-observability.js";
import { NOOP_APM, type ApmPort } from "@artgod/shared/observability/apm";
import { ORDER_PROCESSING_OPERATION } from "../../application/orders/observability.js";
import {
    SYNC_WORK_CLASS,
    type SyncWorkClass,
} from "@artgod/shared/types/sync-work-class";

/** FIFO admission; fixed runtime executors bound the waiting list. */
export class FairOrderValidationAdmission implements OrderValidationAdmissionPort {
    private active = 0;
    private gapActive = 0;
    private readonly waiting: Array<{
        workClass: SyncWorkClass;
        grant: () => void;
    }> = [];
    constructor(
        private readonly limit: number,
        private readonly observability?: {
            observer?: OrderValidationAdmissionObserver;
            apm?: ApmPort;
        },
        private readonly now: () => number = Date.now,
    ) {
        if (!Number.isSafeInteger(limit) || limit < 1)
            throw new Error(
                "Validation admission requires a positive capacity",
            );
        this.reportState();
    }
    async run<T>(
        work: () => Promise<T>,
        signal?: AbortSignal,
        workClass: SyncWorkClass = SYNC_WORK_CLASS.Main,
    ): Promise<T> {
        signal?.throwIfAborted();
        const waitingAt = this.now();
        try {
            if (
                this.active >= this.limit ||
                (workClass === SYNC_WORK_CLASS.GapRepair && this.gapActive > 0)
            )
                await (this.observability?.apm ?? NOOP_APM).withSpan(
                    ORDER_PROCESSING_OPERATION.ValidationWait,
                    { capacity: this.limit },
                    () =>
                        new Promise<void>((resolve, reject) => {
                            const abort = () => {
                                const index = this.waiting.indexOf(waiter);
                                if (index < 0) return;
                                this.waiting.splice(index, 1);
                                this.reportState();
                                reject(signal!.reason);
                            };
                            const waiter = {
                                workClass,
                                grant: () => {
                                    signal?.removeEventListener("abort", abort);
                                    resolve();
                                },
                            };
                            this.waiting.push(waiter);
                            this.reportState();
                            signal?.addEventListener("abort", abort, {
                                once: true,
                            });
                        }),
                );
            else {
                this.active++;
                if (workClass === SYNC_WORK_CLASS.GapRepair) this.gapActive++;
                this.reportState();
            }
        } catch (error) {
            observeBestEffort(() =>
                this.observability?.observer?.admissionWait(
                    this.now() - waitingAt,
                    true,
                ),
            );
            throw error;
        }
        observeBestEffort(() =>
            this.observability?.observer?.admissionWait(
                this.now() - waitingAt,
                false,
            ),
        );
        try {
            signal?.throwIfAborted();
            return await work();
        } finally {
            this.active--;
            if (workClass === SYNC_WORK_CLASS.GapRepair) this.gapActive--;
            while (this.active < this.limit) {
                const main = this.waiting.findIndex(
                    (waiter) => waiter.workClass === SYNC_WORK_CLASS.Main,
                );
                const gap =
                    this.gapActive === 0
                        ? this.waiting.findIndex(
                              (waiter) =>
                                  waiter.workClass ===
                                  SYNC_WORK_CLASS.GapRepair,
                          )
                        : -1;
                // A single background validator leaves capacity for main. Main may
                // use every slot when no background requirement is waiting.
                const index =
                    gap >= 0 && this.active > 0 ? gap : main >= 0 ? main : gap;
                if (index < 0) break;
                const [next] = this.waiting.splice(index, 1);
                this.active++;
                if (next!.workClass === SYNC_WORK_CLASS.GapRepair)
                    this.gapActive++;
                next!.grant();
            }
            this.reportState();
        }
    }
    private reportState(): void {
        observeBestEffort(() =>
            this.observability?.observer?.admissionState(
                this.active,
                this.waiting.length,
                this.limit,
            ),
        );
    }
}
