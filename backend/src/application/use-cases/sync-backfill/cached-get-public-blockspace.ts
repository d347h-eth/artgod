import type { ChainRecord } from "@artgod/shared/types/browse";
import { setMaxListeners } from "node:events";
import { normalizeSlugRef } from "@artgod/shared/utils/ref-resolver";
import {
    ReadModelBadRequestError,
    ReadModelNotFoundError,
} from "@artgod/shared/read-models/errors";
import { NOOP_APM, type ApmPort } from "@artgod/shared/observability/apm";
import { logger } from "@artgod/shared/utils";
import {
    QUERY_CACHE_NAMESPACES,
    type QueryCachePort,
} from "../../../ports/query-cache.js";
import {
    markCurrentQueryCacheHit,
    markCurrentQueryCacheMiss,
} from "../../../utils/query-cache-debug.js";
import {
    GetSyncBackfillStateUseCase,
    type ChainHeadPort,
    type ChainRefResolverPort,
    type GetSyncBackfillStateInput,
    type GetSyncBackfillStateOutput,
    type GetSyncBackfillRangeSummaryInput,
    type GetSyncBackfillRangeSummaryOutput,
} from "./get-sync-backfill-state.js";
import {
    PublicBlockspaceScopeNotFoundError,
    PublicBlockspaceUnavailableError,
    type PublicBlockspaceCoveragePort,
    type PublicBlockspaceScope,
} from "./public-blockspace-coverage.js";

export const PUBLIC_BLOCKSPACE_CACHE_LIMITS = Object.freeze({
    maxResponses: 64,
    maxPendingResponses: 8,
    maxRequests: 64,
});

const CACHE_COMPONENT = "PublicCollectionBlockspaceCache";
const CACHE_REFRESH_ACTION = "refresh";

type Response = GetSyncBackfillStateOutput | GetSyncBackfillRangeSummaryOutput;
type Generation = {
    useCase: GetSyncBackfillStateUseCase;
    responses: QueryCachePort;
    pending: Map<string, Promise<Response>>;
    storedAt: number;
};

/** One scope, one demand-driven freshness clock, and complete response reuse. */
export class CachedGetPublicBlockspace {
    private generation: Generation | null = null;
    private loading: Promise<Generation> | null = null;
    private lastFailure: Error | null = null;
    private nextAttemptAt = -Infinity;
    private requests = 0;
    private pendingResponses = 0;
    private readonly shutdown = new AbortController();

    constructor(
        private readonly scope: PublicBlockspaceScope,
        private readonly refreshMs: number,
        private readonly chains: ChainRefResolverPort,
        private readonly coverage: PublicBlockspaceCoveragePort,
        private readonly head: ChainHeadPort,
        private readonly createResponseCache: () => QueryCachePort,
        private readonly apm: ApmPort = NOOP_APM,
    ) {
        setMaxListeners(
            PUBLIC_BLOCKSPACE_CACHE_LIMITS.maxRequests + 1,
            this.shutdown.signal,
        );
    }

    getState(
        input: GetSyncBackfillStateInput,
    ): Promise<GetSyncBackfillStateOutput> {
        // Root is distinct from a deterministic deeper page. Head/tip never
        // enter identity, and malformed numeric values cannot alias root.
        const key = JSON.stringify([
            "state",
            input.pageStartBlock == null && input.bucketSize == null
                ? "root"
                : "page",
            String(input.pageStartBlock ?? ""),
            String(input.bucketSize ?? ""),
            input.collectionOptions ?? "all",
        ]);
        return this.request(input, key, (useCase) =>
            useCase.getState(input),
        ) as Promise<GetSyncBackfillStateOutput>;
    }

    getRangeSummary(
        input: GetSyncBackfillRangeSummaryInput,
    ): Promise<GetSyncBackfillRangeSummaryOutput> {
        const key = JSON.stringify([
            "range",
            String(input.fromBlock),
            String(input.toBlock),
        ]);
        return this.request(input, key, (useCase) =>
            useCase.getRangeSummary(input),
        ) as Promise<GetSyncBackfillRangeSummaryOutput>;
    }

    /** Called from preClose, before Fastify waits for active HTTP requests. */
    async stop(): Promise<void> {
        this.shutdown.abort(new PublicBlockspaceUnavailableError());
        this.generation = null;
        // SQLite work is owned here and aborts at its next bounded yield. Do
        // not wait for foreign RPC calls; they retain their existing timeouts.
        await this.loading?.catch(() => undefined);
    }

    private async request(
        input: Pick<GetSyncBackfillStateInput, "chainRef" | "collectionRef">,
        key: string,
        run: (useCase: GetSyncBackfillStateUseCase) => Promise<Response>,
    ): Promise<Response> {
        this.shutdown.signal.throwIfAborted();
        const chain = this.chains.resolveChainRef(
            input.chainRef,
            this.scope.chainId,
        );
        if (
            chain.publicChainId !== this.scope.chainId ||
            normalizeSlugRef(input.collectionRef ?? "") !==
                normalizeSlugRef(this.scope.collectionRef)
        ) {
            throw new ReadModelNotFoundError("Unknown blockspace collection");
        }
        if (this.requests >= PUBLIC_BLOCKSPACE_CACHE_LIMITS.maxRequests)
            throw new PublicBlockspaceUnavailableError();
        this.requests += 1;
        const signal = this.shutdown.signal;
        let onAbort: () => void = () => {};
        try {
            const cancelled = new Promise<never>((_resolve, reject) => {
                onAbort = () => reject(signal.reason);
                signal.addEventListener("abort", onAbort, { once: true });
            });
            return await Promise.race([
                this.response(chain, key, run),
                cancelled,
            ]);
        } finally {
            signal.removeEventListener("abort", onAbort);
            this.requests -= 1;
        }
    }

    private async response(
        chain: ChainRecord,
        key: string,
        run: (useCase: GetSyncBackfillStateUseCase) => Promise<Response>,
    ): Promise<Response> {
        const generation = await this.currentGeneration(chain);
        this.shutdown.signal.throwIfAborted();
        if (this.generation !== generation)
            return this.response(chain, key, run);
        const cached = generation.responses.get<Response>(
            QUERY_CACHE_NAMESPACES.PublicBlockspaceResponse,
            key,
        );
        if (cached !== undefined) {
            markCurrentQueryCacheHit({
                storedAt: generation.storedAt,
                ttlMs: this.refreshMs,
            });
            return cached;
        }
        markCurrentQueryCacheMiss({ ttlMs: this.refreshMs });
        let pending = generation.pending.get(key);
        if (!pending) {
            if (
                this.pendingResponses >=
                PUBLIC_BLOCKSPACE_CACHE_LIMITS.maxPendingResponses
            )
                throw new PublicBlockspaceUnavailableError();
            this.pendingResponses += 1;
            pending = Promise.resolve()
                .then(() => run(generation.useCase))
                .then((output) => {
                    this.shutdown.signal.throwIfAborted();
                    if (this.generation === generation) {
                        // Lifetime is owned by this generation, with no separate
                        // response TTL or age reset on hits/navigation.
                        generation.responses.set(
                            QUERY_CACHE_NAMESPACES.PublicBlockspaceResponse,
                            key,
                            output,
                            Infinity,
                        );
                    }
                    return output;
                })
                .finally(() => {
                    generation.pending.delete(key);
                    this.pendingResponses -= 1;
                });
            generation.pending.set(key, pending);
        }
        try {
            const output = await pending;
            this.shutdown.signal.throwIfAborted();
            if (this.generation !== generation)
                return this.response(chain, key, run);
            return output;
        } catch (error) {
            // A stale head can reject a page that an already running refresh
            // will admit. Retry only against that completed replacement.
            if (error instanceof ReadModelBadRequestError) {
                await this.loading?.catch(() => undefined);
                if (this.generation !== generation)
                    return this.response(chain, key, run);
            }
            throw error;
        }
    }

    private async currentGeneration(chain: ChainRecord): Promise<Generation> {
        const current = this.generation;
        if (!current || Date.now() - current.storedAt >= this.refreshMs)
            this.beginRefresh(chain);
        if (current) return current;
        if (this.loading) return this.loading;
        throw this.lastFailure ?? new PublicBlockspaceUnavailableError();
    }

    private beginRefresh(chain: ChainRecord): void {
        if (this.loading || Date.now() < this.nextAttemptAt) return;
        this.nextAttemptAt = Date.now() + this.refreshMs;
        this.loading = Promise.resolve()
            .then(async () => {
                const readPort = await this.coverage.load(
                    this.scope,
                    this.shutdown.signal,
                );
                this.shutdown.signal.throwIfAborted();
                // Capture one result, including failure. The existing use case
                // still owns indexed fallback and root/head-lag count behavior.
                const head = Promise.resolve().then(() =>
                    this.head.getCurrentBlockNumber(),
                );
                void head.catch(() => undefined);
                const generation: Generation = {
                    useCase: new GetSyncBackfillStateUseCase(
                        this.scope.chainId,
                        { resolveChainRef: () => chain },
                        readPort,
                        {
                            getCurrentBlockNumber: () => head,
                            getBlockTimestamp: (block) =>
                                this.head.getBlockTimestamp(block),
                        },
                        this.apm,
                    ),
                    responses: this.createResponseCache(),
                    pending: new Map(),
                    storedAt: Date.now(),
                };
                this.generation = generation;
                this.lastFailure = null;
                logger.info("Public blockspace cache refreshed", {
                    component: CACHE_COMPONENT,
                    action: CACHE_REFRESH_ACTION,
                    chainId: this.scope.chainId,
                    collectionRef: this.scope.collectionRef,
                });
                return generation;
            })
            .catch((error: unknown) => {
                if (error instanceof PublicBlockspaceScopeNotFoundError)
                    this.generation = null;
                this.lastFailure =
                    error instanceof PublicBlockspaceScopeNotFoundError
                        ? error
                        : new PublicBlockspaceUnavailableError({
                              cause: error,
                          });
                if (!this.shutdown.signal.aborted)
                    logger.error("Public blockspace cache refresh failed", {
                        component: CACHE_COMPONENT,
                        action: CACHE_REFRESH_ACTION,
                        chainId: this.scope.chainId,
                        collectionRef: this.scope.collectionRef,
                        error: String(error),
                    });
                throw this.lastFailure;
            })
            .finally(() => {
                this.loading = null;
            });
        // Stale callers deliberately do not await the replacement.
        void this.loading.catch(() => undefined);
    }
}
