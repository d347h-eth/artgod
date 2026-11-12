import { getRpcBudgetDeferral } from "@artgod/shared/evm/rpc-budget";
import { logger } from "@artgod/shared/utils";
import {
    DOMAIN_SYNC_PROJECTION,
    type MetadataRefreshPayload,
} from "../../domain/domain-jobs.js";
import type {
    MetadataDomainSyncResult,
    MetadataRefreshResult,
    MetadataUpdatedToken,
} from "../../domain/metadata.js";
import {
    METADATA_PENDING_POLICY as POLICY,
    METADATA_PENDING_REASON as REASON,
    METADATA_PENDING_LOG,
    decideMetadataContentRetry,
    type MetadataAttempt,
    type MetadataReadinessDecision,
    type MetadataReadinessPort,
} from "../../domain/metadata-pending.js";
import type {
    DomainSyncContext,
    MetadataDomainPort,
} from "../../ports/domain-handlers.js";
import type {
    MetadataFetcherPort,
    TokenUriResolverPort,
} from "../../ports/metadata.js";
import type { MetadataStorePort } from "../../ports/metadata-store.js";

/** Canonical metadata orchestration, shared by bootstrap, transport jobs and the pending poller. */
export class MetadataDomain implements MetadataDomainPort {
    constructor(
        private readonly input: {
            resolver: TokenUriResolverPort;
            fetcher: MetadataFetcherPort;
            store: MetadataStorePort;
            readiness: MetadataReadinessPort;
            now?: () => number;
        },
    ) {}

    async handleDomainSync(
        context: DomainSyncContext,
        afterWrite?: (updated: MetadataUpdatedToken) => void,
    ): Promise<MetadataDomainSyncResult> {
        const contracts = new Set<string>();
        const updatedTokens: MetadataUpdatedToken[] = [];
        if (
            context.fromBlock > context.toBlock ||
            context.projection === DOMAIN_SYNC_PROJECTION.FactsOnly
        )
            return { contracts: [], updatedTokens };
        let tokens = 0;
        for (const candidate of this.input.store.candidates(context)) {
            contracts.add(candidate.contract);
            tokens++;
            // Pending rows, including successful placeholders, progress through the poller.
            if (this.input.store.hasMetadata(candidate)) continue;
            const attempt = this.input.store.begin(
                candidate,
                {},
                this.now(),
                candidate.attribution,
            );
            if (!attempt) continue;
            const updated = await this.fetch(
                attempt,
                undefined,
                undefined,
                afterWrite,
            );
            if (updated) updatedTokens.push(updated);
        }
        logger.debug("Metadata domain sync applied", {
            component: "MetadataDomain",
            action: "handleDomainSync",
            chainId: context.chainId,
            fromBlock: context.fromBlock,
            toBlock: context.toBlock,
            tokens,
            fetched: updatedTokens.length,
        });
        return { contracts: [...contracts], updatedTokens };
    }

    async handleMetadataRefresh(
        payload: MetadataRefreshPayload,
    ): Promise<MetadataRefreshResult> {
        const target = this.input.store.target(
            payload.chainId,
            payload.collectionId,
            payload.tokenId,
        );
        if (!target) return null;
        target.standard = payload.standard ?? target.standard;
        const attempt = this.input.store.begin(
            target,
            {
                imageSourceField: payload.imageSourceField,
                animationSourceField: payload.animationSourceField,
            },
            this.now(),
            {
                blockNumber: payload.blockNumber,
                blockHash: payload.blockHash,
                blockTimestamp: payload.blockTimestamp,
            },
        );
        if (!attempt) return null;
        const updated = await this.fetch(
            attempt,
            payload.metadataUrl,
            payload.blockNumber,
        );
        if (updated)
            logger.debug("Metadata refresh applied", {
                component: "MetadataDomain",
                action: "handleMetadataRefresh",
                chainId: payload.chainId,
                collectionId: payload.collectionId,
                tokenId: payload.tokenId,
                reason: payload.reason,
            });
        return updated;
    }

    /** One indexed claim, with canonical URI/current ownership evidence, and no retry broker job. */
    async retryPending(
        chainId: number,
        afterWrite: (
            updated: MetadataUpdatedToken,
            attempt: MetadataAttempt,
        ) => void,
    ): Promise<MetadataAttempt | null> {
        const attempt = this.input.store.claimDue(chainId, this.now());
        if (!attempt) return null;
        await this.fetch(attempt, null, undefined, (updated) =>
            afterWrite(updated, attempt),
        );
        return attempt;
    }

    pendingSummary(chainId: number) {
        return this.input.store.pendingSummary(chainId, this.now());
    }

    private now(): number {
        return (this.input.now ?? Date.now)();
    }

    private async fetch(
        attempt: MetadataAttempt,
        suppliedUri?: string | null,
        blockNumber?: number,
        afterWrite?: (updated: MetadataUpdatedToken) => void,
    ): Promise<MetadataRefreshResult> {
        const timer = setInterval(() => {
            try {
                this.input.store.renew(attempt, this.now());
            } catch {
                /* Lease ownership is rechecked in the commit transaction. */
            }
        }, POLICY.renewMs);
        timer.unref?.();
        try {
            const uri =
                suppliedUri?.trim() ||
                (await this.input.resolver.resolveTokenUri(
                    attempt.target.contract,
                    attempt.target.tokenId,
                    attempt.target.standard,
                    blockNumber,
                ));
            if (!uri) {
                this.input.store.defer(
                    attempt,
                    REASON.UriUnavailable,
                    this.now(),
                );
                return null;
            }
            const metadata = await this.input.fetcher.fetchMetadata(
                uri,
                attempt.options,
            );
            if (!metadata) {
                this.input.store.defer(
                    attempt,
                    REASON.FetchUnavailable,
                    this.now(),
                );
                return null;
            }
            const ready = this.input.readiness.isReady(
                attempt.target,
                metadata,
            );
            const now = this.now();
            const policy = ready
                ? null
                : this.input.readiness.contentRetryPolicy?.(attempt.target);
            const decision: MetadataReadinessDecision = ready
                ? { ready: true }
                : {
                      ready: false,
                      contentRetry: policy
                          ? decideMetadataContentRetry(
                                attempt.contentPendingAt,
                                now,
                                policy,
                            )
                          : undefined,
                  };
            const updated = this.input.store.complete(
                attempt,
                metadata,
                decision,
                now,
                afterWrite,
            );
            logger.debug(METADATA_PENDING_LOG.Assessed, {
                component: METADATA_PENDING_LOG.Component,
                chainId: attempt.target.chainId,
                collectionId: attempt.target.collectionId,
                tokenId: attempt.target.tokenId,
                ready,
                written: updated !== null,
                retry: attempt.retry,
                attempts: attempt.attempts,
            });
            return updated;
        } catch (error) {
            const deferred = getRpcBudgetDeferral(error);
            this.input.store.defer(
                attempt,
                deferred ? REASON.Deferred : REASON.Interrupted,
                this.now(),
                deferred?.retryAfterMs,
            );
            if (!deferred) throw error;
            // The durable obligation replaces prolonged broker quota/redelivery waiting.
            return null;
        } finally {
            clearInterval(timer);
        }
    }
}
