import type { PendingCanonicalCheck } from "../domain/canonical-check.js";

/** One reorg runtime per chain reads bounded DB-owned work. No broker lease or cursor owns it. */
export interface CanonicalChecksPort {
    /** Retain only while the stored identity/revision still match. Ordinary
     * checks preserve backoff; explicit disputes gate progress and become due
     * immediately. Call after a failed writer exits, or within its owning writer.
     */
    retain(
        check: PendingCanonicalCheck,
        options?: { disputed: boolean },
    ): boolean;
    hasPending(chainId: number, now: number): boolean;
    nextDue(input: {
        chainId: number;
        now: number;
        upperBound: number;
    }): PendingCanonicalCheck | null;
    /** Recovery handoff consumes this stored identity/revision without clearing
     * its dispute. A supplied generation additionally fences the exact claim. */
    complete(check: PendingCanonicalCheck): boolean;
    /** Fresh matching-header confirmation repairs source barriers and clears
     * only this dispute generation; other disputes and recovery remain gated. */
    confirmCanonicalBlock(check: PendingCanonicalCheck): boolean;
    defer(check: PendingCanonicalCheck, retryAt: number): void;
}
