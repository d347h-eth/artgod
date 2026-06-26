import { db } from "@artgod/shared/database";
import type { BetterSqlite3NamedStatement } from "@artgod/shared/database";
import { parseOpenSeaBiddingOffer } from "@artgod/shared/trading/open-sea-bidding-offers";
import {
    TRADING_BIDDING_BID_BOOK_SOURCE,
    type TradingBiddingBidScopeKind,
} from "@artgod/shared/types";
import type { CollectionOfferSnapshot } from "../../application/use-cases/bidding/collection-offer-snapshot-service.js";
import type {
    BiddingBidBookProjectionErrorInput,
    BiddingBidBookProjectionPort,
    BiddingBidBookProjectionResult,
} from "../../application/use-cases/bidding/bidding-bid-book-projection.js";
import {
    BIDDING_LOG_COMPONENT,
    createBiddingComponentLogger,
} from "../../utils/bidding-log.js";

type CollectionRow = {
    collection_id: number;
    slug: string;
    opensea_slug: string | null;
    address: string;
};

type BidBookProjectionRow = {
    orderId: string;
    source: typeof TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot;
    scopeKind: TradingBiddingBidScopeKind;
    scopeLabel: string;
    tokenId: string | null;
    scopeTraitsJson: string;
    encodedTokenIds: string | null;
    maker: string;
    isOwn: number;
    priceWei: string;
    quantity: string;
    currencyAddress: string | null;
    currencySymbol: string | null;
    protocolAddress: string | null;
    validUntil: number | null;
    placedAt: string | null;
    snapshotRefreshedAtMs: number;
};

const log = createBiddingComponentLogger(
    BIDDING_LOG_COMPONENT.SqliteBiddingBidBookProjection,
);

export class SqliteBiddingBidBookProjection
    implements BiddingBidBookProjectionPort
{
    private readonly selectCollection: BetterSqlite3NamedStatement<{
        chainId: number;
        collectionSlug: string;
    }>;
    private readonly deleteSnapshotRows: BetterSqlite3NamedStatement<{
        chainId: number;
        collectionId: number;
        source: typeof TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot;
    }>;
    private readonly insertSnapshotRow: BetterSqlite3NamedStatement<
        BidBookProjectionRow & {
            chainId: number;
            collectionId: number;
        }
    >;
    private readonly upsertState: BetterSqlite3NamedStatement<{
        chainId: number;
        collectionId: number;
        source: typeof TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot;
        snapshotRefreshedAtMs: number;
        projectedAt: string;
        rowCount: number;
        durationMs: number;
        lastError: string | null;
    }>;
    private readonly recordStateError: BetterSqlite3NamedStatement<{
        chainId: number;
        collectionId: number;
        source: typeof TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot;
        snapshotRefreshedAtMs: number;
        projectedAt: string;
        durationMs: number;
        lastError: string;
    }>;

    constructor(
        private readonly chainId: number,
        private readonly makerAddress: string,
        private readonly wethAddress: string,
    ) {
        this.selectCollection = db.prepare<{
            chainId: number;
            collectionSlug: string;
        }>(
            "SELECT collection_id, slug, opensea_slug, address " +
                "FROM collections " +
                "WHERE chain_id = @chainId " +
                "AND (slug = @collectionSlug OR opensea_slug = @collectionSlug) " +
                "LIMIT 1",
        ) as BetterSqlite3NamedStatement<{
            chainId: number;
            collectionSlug: string;
        }>;

        this.deleteSnapshotRows = db.prepare<{
            chainId: number;
            collectionId: number;
            source: typeof TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot;
        }>(
            "DELETE FROM trading_bidding_bid_book_rows " +
                "WHERE chain_id = @chainId AND collection_id = @collectionId AND source = @source",
        ) as BetterSqlite3NamedStatement<{
            chainId: number;
            collectionId: number;
            source: typeof TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot;
        }>;

        this.insertSnapshotRow = db.prepare<
            BidBookProjectionRow & {
                chainId: number;
                collectionId: number;
            }
        >(
            "INSERT INTO trading_bidding_bid_book_rows " +
                "(chain_id, collection_id, order_id, source, scope_kind, scope_label, token_id, scope_traits_json, encoded_token_ids, maker, is_own, price_wei, quantity, currency_address, currency_symbol, protocol_address, valid_until, placed_at, snapshot_refreshed_at_ms, seen_at) " +
                "VALUES (@chainId, @collectionId, @orderId, @source, @scopeKind, @scopeLabel, @tokenId, @scopeTraitsJson, @encodedTokenIds, @maker, @isOwn, @priceWei, @quantity, @currencyAddress, @currencySymbol, @protocolAddress, @validUntil, @placedAt, @snapshotRefreshedAtMs, CURRENT_TIMESTAMP)",
        ) as BetterSqlite3NamedStatement<
            BidBookProjectionRow & {
                chainId: number;
                collectionId: number;
            }
        >;

        this.upsertState = db.prepare<{
            chainId: number;
            collectionId: number;
            source: typeof TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot;
            snapshotRefreshedAtMs: number;
            projectedAt: string;
            rowCount: number;
            durationMs: number;
            lastError: string | null;
        }>(
            "INSERT INTO trading_bidding_collection_bid_book_state " +
                "(chain_id, collection_id, source, snapshot_refreshed_at_ms, projected_at, row_count, duration_ms, last_error) " +
                "VALUES (@chainId, @collectionId, @source, @snapshotRefreshedAtMs, @projectedAt, @rowCount, @durationMs, @lastError) " +
                "ON CONFLICT(chain_id, collection_id, source) DO UPDATE SET " +
                "snapshot_refreshed_at_ms = excluded.snapshot_refreshed_at_ms, " +
                "projected_at = excluded.projected_at, " +
                "row_count = excluded.row_count, " +
                "duration_ms = excluded.duration_ms, " +
                "last_error = excluded.last_error",
        ) as BetterSqlite3NamedStatement<{
            chainId: number;
            collectionId: number;
            source: typeof TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot;
            snapshotRefreshedAtMs: number;
            projectedAt: string;
            rowCount: number;
            durationMs: number;
            lastError: string | null;
        }>;

        this.recordStateError = db.prepare<{
            chainId: number;
            collectionId: number;
            source: typeof TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot;
            snapshotRefreshedAtMs: number;
            projectedAt: string;
            durationMs: number;
            lastError: string;
        }>(
            "INSERT INTO trading_bidding_collection_bid_book_state " +
                "(chain_id, collection_id, source, snapshot_refreshed_at_ms, projected_at, row_count, duration_ms, last_error) " +
                "VALUES (@chainId, @collectionId, @source, @snapshotRefreshedAtMs, @projectedAt, 0, @durationMs, @lastError) " +
                "ON CONFLICT(chain_id, collection_id, source) DO UPDATE SET " +
                "snapshot_refreshed_at_ms = excluded.snapshot_refreshed_at_ms, " +
                "projected_at = excluded.projected_at, " +
                "duration_ms = excluded.duration_ms, " +
                "last_error = excluded.last_error",
        ) as BetterSqlite3NamedStatement<{
            chainId: number;
            collectionId: number;
            source: typeof TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot;
            snapshotRefreshedAtMs: number;
            projectedAt: string;
            durationMs: number;
            lastError: string;
        }>;
    }

    async replaceCollectionBidBook(
        snapshot: CollectionOfferSnapshot,
        reason: string,
    ): Promise<BiddingBidBookProjectionResult> {
        const startedAt = Date.now();
        const collection = this.selectCollection.get({
            chainId: this.chainId,
            collectionSlug: snapshot.collectionSlug,
        }) as CollectionRow | undefined;
        if (!collection) {
            log.warn(
                "collectionMissing",
                "Skipping bid-book projection because collection was not found",
                { collectionSlug: snapshot.collectionSlug },
            );
            return {
                collectionSlug: snapshot.collectionSlug,
                rowCount: 0,
                durationMs: Date.now() - startedAt,
            };
        }

        const rows = this.mapSnapshotRows(snapshot, collection);
        const durationBeforeWriteMs = Date.now() - startedAt;

        // Replace the projected bid book transactionally so UI readers never see a partial snapshot.
        db.raw.transaction(() => {
            this.deleteSnapshotRows.run({
                chainId: this.chainId,
                collectionId: collection.collection_id,
                source: TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot,
            });
            for (const row of rows) {
                this.insertSnapshotRow.run({
                    chainId: this.chainId,
                    collectionId: collection.collection_id,
                    ...row,
                });
            }

            const durationMs = Date.now() - startedAt;
            this.upsertState.run({
                chainId: this.chainId,
                collectionId: collection.collection_id,
                source: TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot,
                snapshotRefreshedAtMs: snapshot.refreshedAt,
                projectedAt: new Date().toISOString(),
                rowCount: rows.length,
                durationMs,
                lastError: null,
            });
        })();

        const durationMs = Date.now() - startedAt;
        log.info("bidBookReplaced", "Replaced projected bid book", {
            collectionSlug: snapshot.collectionSlug,
            reason,
            rowCount: rows.length,
            parseDurationMs: durationBeforeWriteMs,
            durationMs,
        });
        return {
            collectionSlug: snapshot.collectionSlug,
            rowCount: rows.length,
            durationMs,
        };
    }

    async recordCollectionBidBookError(
        input: BiddingBidBookProjectionErrorInput,
    ): Promise<void> {
        const collection = this.selectCollection.get({
            chainId: this.chainId,
            collectionSlug: input.snapshot.collectionSlug,
        }) as CollectionRow | undefined;
        if (!collection) {
            log.warn(
                "collectionMissingForProjectionError",
                "Skipping bid-book projection error record because collection was not found",
                { collectionSlug: input.snapshot.collectionSlug },
            );
            return;
        }

        // Mark the bot snapshot source as unhealthy while preserving the last good rows for diagnostics.
        this.recordStateError.run({
            chainId: this.chainId,
            collectionId: collection.collection_id,
            source: TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot,
            snapshotRefreshedAtMs: input.snapshot.refreshedAt,
            projectedAt: new Date().toISOString(),
            durationMs: input.durationMs,
            lastError: input.errorMessage,
        });

        log.warn(
            "bidBookProjectionErrorRecorded",
            "Recorded bid-book projection error",
            {
                collectionSlug: input.snapshot.collectionSlug,
                reason: input.reason,
                durationMs: input.durationMs,
            },
        );
    }

    private mapSnapshotRows(
        snapshot: CollectionOfferSnapshot,
        collection: CollectionRow,
    ): BidBookProjectionRow[] {
        const rows = new Map<string, BidBookProjectionRow>();

        for (const rawOffer of snapshot.offers) {
            const row = this.mapOffer(rawOffer, snapshot, collection);
            if (!row || rows.has(row.orderId)) {
                continue;
            }
            rows.set(row.orderId, row);
        }

        return Array.from(rows.values());
    }

    private mapOffer(
        rawOffer: unknown,
        snapshot: CollectionOfferSnapshot,
        collection: CollectionRow,
    ): BidBookProjectionRow | null {
        // Parse snapshot offers through the bidder-owned OpenSea semantics before writing UI rows.
        const parsed = parseOpenSeaBiddingOffer(rawOffer, {
            collectionAddress: collection.address,
            wethAddress: this.wethAddress,
            discoverySource: "collectionOffers",
        });
        if (!parsed || parsed.price <= 0n) {
            return null;
        }

        const scope = parsed.bidScope;

        return {
            orderId: parsed.id,
            source: TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot,
            scopeKind: scope.kind,
            scopeLabel: scope.label,
            tokenId: scope.tokenId,
            scopeTraitsJson: JSON.stringify(scope.traits),
            encodedTokenIds: scope.encodedTokenIds,
            maker: parsed.maker,
            isOwn:
                parsed.maker.toLowerCase() === this.makerAddress.toLowerCase()
                    ? 1
                    : 0,
            priceWei: parsed.price.toString(),
            quantity: parsed.quantity.toString(),
            currencyAddress: this.wethAddress.toLowerCase(),
            currencySymbol: "WETH",
            protocolAddress: parsed.protocolAddress ?? null,
            validUntil: parsed.expirationTime ?? null,
            placedAt: parsed.createdAt ?? epochSecondsToRfc3339(parsed.validFrom),
            snapshotRefreshedAtMs: snapshot.refreshedAt,
        };
    }
}

function epochSecondsToRfc3339(value: number | undefined): string | null {
    if (value === undefined || !Number.isFinite(value) || value <= 0) {
        return null;
    }

    return new Date(Math.floor(value * 1000)).toISOString().replace(".000Z", "Z");
}
