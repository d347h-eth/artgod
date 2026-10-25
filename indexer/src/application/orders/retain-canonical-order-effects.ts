import { ChainSyncConflict } from "../../domain/chain-sync.js";
import {
    canonicalOrderEffectId,
    type CanonicalOrderEffectsInput,
} from "../../domain/canonical-order-effects.js";
import { ORDER_JOB_KIND } from "../../domain/order-jobs.js";
import type {
    CanonicalOrderEffectsPort,
    CanonicalOrderProjectionPort,
} from "../../ports/canonical-order-effects.js";
import type { MakerRevalidationStore } from "../../ports/maker-revalidation.js";

/** Direct durable admission precedes checkpoint publication. Broker delivery is
 * an optional wakeup; it is never the only record of an affected order scope. */
export class RetainCanonicalOrderEffects implements CanonicalOrderEffectsPort {
    constructor(
        private readonly ports: {
            orders: CanonicalOrderProjectionPort;
            makers: Pick<MakerRevalidationStore, "admit" | "scheduleWakeup">;
        },
    ) {}

    retain(input: CanonicalOrderEffectsInput): void {
        if (
            input.effects.some(
                (effect) => effect.payload.chainId !== input.checkpoint.chainId,
            )
        )
            throw new ChainSyncConflict(
                "Canonical order effect belongs to another chain",
            );
        for (const effect of input.effects) {
            if (effect.kind === ORDER_JOB_KIND.UpdateById) {
                this.ports.orders.applyCanonicalOrderUpdate(
                    effect.payload,
                    input.checkpoint,
                    input.now,
                );
            } else {
                const run = this.ports.makers.admit({
                    jobId: canonicalOrderEffectId(effect),
                    payload: effect.payload,
                    // Chain coverage, never source/delivery time, establishes the
                    // obligation. The maker store captures its finite scan boundary.
                    now: input.now,
                });
                // Only admitted scopes need delivery. Admission and the existing
                // idempotent continuation share the enclosing sync transaction.
                if (run) this.ports.makers.scheduleWakeup(run, input.now);
            }
        }
    }
}
