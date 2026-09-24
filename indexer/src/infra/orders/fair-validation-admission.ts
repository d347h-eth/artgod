import type { OrderValidationAdmissionPort } from "../../ports/order-validation-admission.js";

/** FIFO admission; the runtime's single-flight workers also bound the waiting list. */
export class FairOrderValidationAdmission implements OrderValidationAdmissionPort {
    private active = 0;
    private readonly waiting: Array<() => void> = [];
    constructor(private readonly limit: number) {
        if (!Number.isSafeInteger(limit) || limit < 1)
            throw new Error(
                "Validation admission requires a positive capacity",
            );
    }
    async run<T>(work: () => Promise<T>): Promise<T> {
        if (this.active >= this.limit)
            await new Promise<void>((resolve) => this.waiting.push(resolve));
        else this.active++;
        try {
            return await work();
        } finally {
            const next = this.waiting.shift();
            // Transfer the permit to the oldest waiter before a new caller can take it.
            if (next) next();
            else this.active--;
        }
    }
}
