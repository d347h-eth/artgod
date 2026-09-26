import type {
    OrderValidationAdmissionPort,
    OrderValidationAdmissionObserver,
} from "../../ports/order-validation-admission.js";
import { observeBestEffort } from "../../application/processing-observability.js";
import { NOOP_APM, type ApmPort } from "@artgod/shared/observability/apm";
import { ORDER_PROCESSING_OPERATION } from "../../application/orders/observability.js";

/** FIFO admission; fixed runtime executors bound the waiting list. */
export class FairOrderValidationAdmission implements OrderValidationAdmissionPort {
    private active = 0;
    private readonly waiting: Array<{ grant: () => void }> = [];
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
    async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        signal?.throwIfAborted();
        const waitingAt = this.now();
        try {
            if (this.active >= this.limit)
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
            const next = this.waiting.shift();
            // Transfer the permit to the oldest waiter before a new caller can take it.
            if (next) next.grant();
            else this.active--;
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
