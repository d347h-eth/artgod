import type { OrderValidationAdmissionPort } from "../../ports/order-validation-admission.js";

/** FIFO admission; fixed runtime executors bound the waiting list. */
export class FairOrderValidationAdmission implements OrderValidationAdmissionPort {
    private active = 0;
    private readonly waiting: Array<{ grant: () => void }> = [];
    constructor(private readonly limit: number) {
        if (!Number.isSafeInteger(limit) || limit < 1)
            throw new Error(
                "Validation admission requires a positive capacity",
            );
    }
    async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        signal?.throwIfAborted();
        if (this.active >= this.limit)
            await new Promise<void>((resolve, reject) => {
                const abort = () => {
                    const index = this.waiting.indexOf(waiter);
                    if (index < 0) return;
                    this.waiting.splice(index, 1);
                    reject(signal!.reason);
                };
                const waiter = {
                    grant: () => {
                        signal?.removeEventListener("abort", abort);
                        resolve();
                    },
                };
                this.waiting.push(waiter);
                signal?.addEventListener("abort", abort, { once: true });
            });
        else this.active++;
        try {
            signal?.throwIfAborted();
            return await work();
        } finally {
            const next = this.waiting.shift();
            // Transfer the permit to the oldest waiter before a new caller can take it.
            if (next) next.grant();
            else this.active--;
        }
    }
}
