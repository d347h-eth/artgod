import type { PendingCanonicalCheck } from "../domain/canonical-check.js";

/** One reorg runtime per chain reads bounded DB-owned work. No broker lease or cursor owns it. */
export interface CanonicalChecksPort {
    hasPending(chainId: number, now: number): boolean;
    nextDue(input: {
        chainId: number;
        now: number;
        upperBound: number;
    }): PendingCanonicalCheck | null;
    /** Complete only this stored hash and rollback revision. May share the recovery writer. */
    complete(check: PendingCanonicalCheck): boolean;
    defer(check: PendingCanonicalCheck, retryAt: number): void;
}
