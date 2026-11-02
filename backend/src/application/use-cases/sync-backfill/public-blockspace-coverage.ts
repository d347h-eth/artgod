import { ReadModelNotFoundError } from "@artgod/shared/read-models/errors";
import type { SyncBackfillReadPort } from "./get-sync-backfill-state.js";

export type PublicBlockspaceScope = {
    chainId: number;
    collectionRef: string;
};

export type PublicBlockspaceCoveragePort = {
    /**
     * Copies one coherent, deployment-clipped collection view. The returned
     * count/collection/tip methods never reread canonical state; timestamp
     * lookups retain the ordinary use case's DB/RPC fallback contract.
     * Releases its private database view before resolving, including on abort.
     */
    load(
        scope: PublicBlockspaceScope,
        signal: AbortSignal,
    ): Promise<SyncBackfillReadPort>;
};

/** Only coverage admission/refresh can retire a previously successful scope. */
export class PublicBlockspaceScopeNotFoundError extends ReadModelNotFoundError {
    constructor() {
        super("Unknown blockspace collection");
    }
}

// The HTTP boundary owns status mapping; operational details remain in logs.
export class PublicBlockspaceUnavailableError extends Error {
    constructor(options?: ErrorOptions) {
        super(
            "Blockspace is temporarily unavailable. Try again shortly.",
            options,
        );
        this.name = "PublicBlockspaceUnavailableError";
    }
}

export const PUBLIC_BLOCKSPACE_UNAVAILABLE_ERROR = "blockspace_unavailable";
