import type { ChainSyncCheckpoint } from "../domain/chain-sync.js";
import type {
    CanonicalOrderEffectsInput,
    CanonicalOrderUpdate,
} from "../domain/canonical-order-effects.js";

/** Synchronous projection inside the coordinator's writer. Definitive lifecycle
 * facts apply directly; uncertain cumulative state retains ordinary demand. */
export interface CanonicalOrderProjectionPort {
    applyCanonicalOrderUpdate(
        payload: CanonicalOrderUpdate,
        checkpoint: ChainSyncCheckpoint,
        now: number,
    ): void;
}

/** Caller owns the transaction coupling these effects to canonical facts and
 * applied progress. This operation performs no network IO or maker scan. */
export interface CanonicalOrderEffectsPort {
    retain(input: CanonicalOrderEffectsInput): void;
}
