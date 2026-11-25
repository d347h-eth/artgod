import { createHash, randomUUID } from "node:crypto";
import { db } from "@artgod/shared/database";
import { MARKET_DATA_STORAGE_POLICY as POLICY } from "@artgod/shared/market-data/storage-policy";
import {
    ORDER_SIDE,
    ORDER_SOURCE_STATUS,
    ORDERBOOK_VENUE,
} from "@artgod/shared/market-data/orders";
import { zeroAddress } from "viem";
import {
    BOOK_VIEW,
    BOOK_CHANGE,
    type BookObservation,
    type BookFeed,
    type BookCoverage,
    type BoundMarketJob,
} from "../../domain/orderbook.js";
import {
    ORDER_JOB_KIND,
    ORDER_UPDATE_REASON,
} from "../../domain/order-jobs.js";
import { orderUpdateQueue } from "../../domain/order-processing.js";
import {
    makeOrderUpsert,
    resolveOrderTokenSet,
} from "../../application/offchain/dispatch.js";
import { ORDER_LOCAL_TOKEN_SET_STATUS } from "../../domain/orders.js";
import { SqliteOrderProjection } from "../domain/orders.js";
import { SqliteDailyListingPrices } from "../storage/sqlite-daily-listing-prices.js";
import { SqliteTokenSetRegistry } from "../token-sets/sqlite.js";
import { SqliteQueueOutbox } from "../queue/sqlite-queue-outbox.js";
import { SqliteCollectionRegistry } from "../collections/sqlite.js";

type FeedState = {
    feed_id: number;
    generation: number;
    binding_revision: number;
    sequence: number | null;
    last_success_ms: number | null;
};
type Staged = {
    native_id: string;
    record_json: string;
    terms: string;
    settlement_id: string | null;
};
type Member = {
    source_ms: number | null;
    observed_ms: number;
    settlement_id: string | null;
    present: number;
    terms: string;
};
type Route = {
    native_id: string;
    record_json: string;
    feed_id: number;
    collection_id: number;
    observed_ms: number;
};
type Scope = {
    chain_id: number;
    collection_id: number;
    token_id: string;
    maker: string;
};
const BATCH = POLICY.maintenanceBatchRows;
class ListingPriceTimeChanged extends Error {}

/** The SQLite writer lock covers the final eligibility decision, daily price and
 * generation switch. Private pages are bounded and disappear on process exit. */
export class SqliteOrderSourceStateStore {
    private readonly scopes = new SqliteCollectionRegistry();
    private readonly tokenSets = new SqliteTokenSetRegistry();
    private readonly outbox = new SqliteQueueOutbox();
    private readonly projection: SqliteOrderProjection;
    private readonly history: SqliteDailyListingPrices;
    private readonly previousMember;
    private readonly previousPlacementOrder;
    private readonly clearOfferScopes;
    private readonly addOfferScope;
    private readonly withdrawMember;
    private readonly crossedAskBoundary;
    private readonly markSeller;
    private readonly winningRoute;
    private readonly deactivateOrder;
    private readonly localOfferScope;
    private readonly publishWinner;
    constructor(
        private readonly weth: string,
        private readonly clock = Date.now,
    ) {
        if (db.prepare("SELECT 1 FROM orderbook_cutover WHERE pending=1").get())
            throw new Error(
                "Run the offline orderbook:cutover before starting market workers",
            );
        this.projection = new SqliteOrderProjection(weth, undefined, () =>
            Math.floor(this.clock() / 1000),
        );
        this.history = new SqliteDailyListingPrices(db, [
            zeroAddress,
            weth.toLowerCase(),
        ]);
        db.exec(`CREATE TEMP TABLE IF NOT EXISTS book_stage(
          run TEXT, native_id TEXT, settlement_id TEXT, terms TEXT, record_json TEXT, PRIMARY KEY(run,native_id)
        ) WITHOUT ROWID;
        CREATE TEMP TABLE IF NOT EXISTS book_dirty(run TEXT,id TEXT,PRIMARY KEY(run,id)) WITHOUT ROWID;
        CREATE TEMP TABLE IF NOT EXISTS book_sellers(run TEXT,chain_id INTEGER,collection_id INTEGER,token_id TEXT,maker TEXT,
          PRIMARY KEY(run,chain_id,collection_id,token_id,maker)) WITHOUT ROWID;`);
        this.previousMember = db.prepare(
            "SELECT settlement_id,present,terms,observed_ms,json_extract(record_json,'$.sourceTime') AS source_ms FROM orderbook_members WHERE feed_id=? AND native_id=?",
        );
        this.previousPlacementOrder = db.prepare(
            "SELECT settlement_id FROM orderbook_members WHERE placement=? AND settlement_id IS NOT NULL LIMIT 1",
        );
        this.clearOfferScopes = db.prepare(
            "DELETE FROM orderbook_offer_scopes WHERE feed_id=? AND native_id=?",
        );
        this.addOfferScope = db.prepare(
            "INSERT INTO orderbook_offer_scopes(feed_id,native_id,collection_id,token_set_id,schema_hash) VALUES(?,?,?,?,?)",
        );
        this.withdrawMember = db.prepare(
            "UPDATE orderbook_members SET present=0,eligible=0,withdrawn=authority*?,record_json=NULL,revision=?,observed_ms=? WHERE feed_id=? AND native_id=?",
        );
        this.crossedAskBoundary = db.prepare(
            `SELECT 1 FROM book_sellers s
             JOIN activities a USING(chain_id,collection_id,token_id,maker)
             JOIN orders o USING(chain_id,collection_id,token_id,maker)
             WHERE s.run=@run AND a.listing_day=@day AND o.side=@sell AND
                 (o.valid_from>@start AND o.valid_from<=@end OR o.valid_until>@start AND o.valid_until<=@end)
             LIMIT 1`,
        );
        this.markSeller = db.prepare(
            "INSERT OR IGNORE INTO book_sellers SELECT ?,chain_id,collection_id,token_id,maker FROM orders WHERE id=? AND side=? AND token_id IS NOT NULL",
        );
        this.winningRoute = db.prepare(
            "SELECT feed_id,native_id,collection_id,record_json,observed_ms FROM orderbook_eligible_routes WHERE settlement_id=? LIMIT 1",
        );
        this.deactivateOrder = db.prepare(
            "UPDATE orders SET source_status=?,state_revision=state_revision+1 WHERE id=? AND source_status=?",
        );
        this.localOfferScope = db.prepare(
            "SELECT token_set_id,schema_hash FROM orderbook_offer_scopes WHERE feed_id=? AND native_id=? AND collection_id=?",
        );
        this.publishWinner = db.prepare(
            "UPDATE orders SET order_hash=?,winning_feed_id=?,winning_native_id=?,required_fees=?,seller_proceeds=? WHERE id=?",
        );
    }

    /** The caller supplies a verified venue reference and an existing local association. */
    bind(feed: BookFeed, collectionId: number): number {
        return db.writeTransaction(() => {
            const collection = this.scopes.getCollection(
                feed.chainId,
                collectionId,
            );
            if (
                !collection ||
                collection.address.toLowerCase() !==
                    feed.contract.toLowerCase() ||
                (feed.venue === ORDERBOOK_VENUE.OpenSea &&
                    (collection.openseaSlug !== feed.reference ||
                        !collection.openseaStatus))
            )
                throw new Error(
                    "Market does not match the local chain and contract",
                );
            db.prepare(
                "INSERT OR IGNORE INTO orderbook_feeds(chain_id,venue,market,contract,view) VALUES(?,?,?,?,?)",
            ).run(
                feed.chainId,
                feed.venue,
                feed.reference,
                feed.contract.toLowerCase(),
                feed.view,
            );
            const state = this.state(feed);
            db.prepare(
                "INSERT OR IGNORE INTO orderbook_bindings(feed_id,collection_id) VALUES(?,?)",
            ).run(state.feed_id, collectionId);
            return state.feed_id;
        })();
    }

    due(venue: BookFeed["venue"], chainId: number, before: number) {
        return db
            .prepare(
                `SELECT feed_id AS feedId,generation,binding_revision AS bindingRevision FROM orderbook_feeds f
                 WHERE venue=? AND chain_id=? AND view=?
                   AND (accepted_binding_revision IS NOT binding_revision OR last_success_ms IS NULL OR last_success_ms<=?)
                   AND (last_attempt_ms IS NULL OR last_attempt_ms<=?)
                   AND EXISTS (SELECT 1 FROM orderbook_bindings WHERE feed_id=f.feed_id)
                 ORDER BY feed_id`,
            )
            .all(
                venue,
                chainId,
                BOOK_VIEW.Public,
                before,
                before,
            ) as BoundMarketJob[];
    }
    current(venue: BookFeed["venue"], chainId: number, job: BoundMarketJob) {
        return db
            .prepare(
                "SELECT chain_id AS chainId,venue,market AS reference,contract,view FROM orderbook_feeds f WHERE feed_id=? AND venue=? AND chain_id=? AND generation=? AND binding_revision=? AND EXISTS (SELECT 1 FROM orderbook_bindings WHERE feed_id=f.feed_id)",
            )
            .get(
                job.feedId,
                venue,
                chainId,
                job.generation,
                job.bindingRevision,
            ) as BookFeed | undefined;
    }
    hasBindings(venue: BookFeed["venue"], chainId: number) {
        return !!db
            .prepare(
                "SELECT 1 FROM orderbook_feeds JOIN orderbook_bindings USING(feed_id) WHERE venue=? AND chain_id=? LIMIT 1",
            )
            .get(venue, chainId);
    }
    private state(feed: BookFeed): FeedState {
        const row = db
            .prepare(
                "SELECT * FROM orderbook_feeds WHERE chain_id=? AND venue=? AND market=? AND contract=? AND view=?",
            )
            .get(
                feed.chainId,
                feed.venue,
                feed.reference,
                feed.contract.toLowerCase(),
                feed.view,
            ) as FeedState | undefined;
        if (!row) throw new Error("Unknown orderbook feed");
        return row;
    }

    alreadyAccepted(feed: BookFeed, since: number): boolean {
        return !!db
            .prepare(
                "SELECT 1 FROM orderbook_feeds WHERE chain_id=? AND venue=? AND market=? AND contract=? AND view=? AND accepted_binding_revision=binding_revision AND last_success_ms>=?",
            )
            .get(
                feed.chainId,
                feed.venue,
                feed.reference,
                feed.contract,
                feed.view,
                since,
            );
    }

    previousObservation(
        feed: BookFeed,
        nativeId: string,
    ): BookObservation | undefined {
        const row = db
            .prepare(
                `SELECT m.record_json FROM orderbook_members m JOIN orderbook_feeds f USING(feed_id)
            WHERE f.chain_id=? AND f.venue=? AND f.market=? AND f.contract=? AND m.native_id=? AND m.authority=1
              AND m.settlement_id IS NOT NULL AND m.record_json IS NOT NULL ORDER BY m.observed_ms DESC LIMIT 1`,
            )
            .get(
                feed.chainId,
                feed.venue,
                feed.reference,
                feed.contract,
                nativeId.toLowerCase(),
            ) as { record_json: string } | undefined;
        return row ? JSON.parse(row.record_json) : undefined;
    }
    acceptsStream(
        feed: BookFeed,
        received: number,
        sourceTime?: number | null,
    ): boolean {
        const latest = db
            .prepare(
                "SELECT last_success_ms FROM orderbook_feeds WHERE chain_id=? AND venue=? AND market=? AND contract=? AND view=?",
            )
            .get(
                feed.chainId,
                feed.venue,
                feed.reference,
                feed.contract,
                BOOK_VIEW.Public,
            ) as { last_success_ms: number | null } | undefined;
        return (
            !latest?.last_success_ms ||
            (received > latest.last_success_ms &&
                (sourceTime == null ||
                    sourceTime + 999 >= latest.last_success_ms))
        );
    }

    begin(
        feed: BookFeed,
        coverage: BookCoverage = { kind: "snapshot" },
        received = this.clock(),
    ) {
        const previous = this.state(feed);
        const run = randomUUID();
        const id = previous.feed_id;
        const bound = () =>
            db
                .prepare(
                    "SELECT collection_id FROM orderbook_bindings WHERE feed_id=? ORDER BY collection_id",
                )
                .all(id) as { collection_id: number }[];
        if (!bound().length) throw new Error("Market has no active binding");
        db.prepare(
            "UPDATE orderbook_feeds SET last_attempt_ms=? WHERE feed_id=?",
        ).run(received, id);
        let published:
            | { activeOrders: number; deactivatedOrders: number }
            | undefined;
        let closed = false;
        const clear = () => {
            for (const table of ["book_stage", "book_dirty", "book_sellers"])
                db.prepare("DELETE FROM " + table + " WHERE run=?").run(run);
            closed = true;
        };
        const stage = db.prepare(
            "INSERT OR IGNORE INTO book_stage(run,native_id,settlement_id,terms,record_json) VALUES(?,?,?,?,?)",
        );
        const stagedTerms = db.prepare(
            "SELECT terms FROM book_stage WHERE run=? AND native_id=?",
        );
        const dirty = db.prepare(
            "INSERT OR IGNORE INTO book_dirty(run,id) VALUES(?,?)",
        );
        return {
            record(record: BookObservation) {
                if (closed || published)
                    throw new Error("Book is already closed");
                // Source timestamps can differ on an otherwise identical observation.
                const { sourceTime, ...terms } = record;
                const digest = createHash("sha256")
                    .update(JSON.stringify(terms))
                    .digest("hex");
                const inserted = stage.run(
                    run,
                    record.nativeId,
                    record.settlementId,
                    digest,
                    JSON.stringify(record),
                );
                if (
                    !inserted.changes &&
                    (stagedTerms.get(run, record.nativeId) as { terms: string })
                        .terms !== digest
                )
                    throw new Error("Conflicting duplicate order within book");
            },
            fail: (reason: unknown) => {
                if (!published)
                    db.writeTransaction(() => {
                        const failed = db
                            .prepare(
                                "UPDATE orderbook_feeds SET last_error=? WHERE feed_id=? AND last_attempt_ms=? AND generation=? AND binding_revision=?",
                            )
                            .run(
                                String(reason),
                                id,
                                received,
                                previous.generation,
                                previous.binding_revision,
                            );
                        if (failed.changes) this.invalidateCollections(id);
                    })();
                clear();
            },
            close: clear,
            publish: () => {
                if (published) return published;
                if (closed) throw new Error("Book is already closed");
                published = db.writeTransaction(() => {
                    const current = this.state(feed);
                    if (
                        current.generation !== previous.generation ||
                        current.binding_revision !==
                            previous.binding_revision ||
                        !bound().length
                    )
                        throw new Error(
                            "Orderbook generation or binding changed during read",
                        );
                    if (coverage.kind === "sequence" && !coverage.baseline) {
                        if (
                            current.sequence !== null &&
                            coverage.position <= current.sequence
                        )
                            return { activeOrders: 0, deactivatedOrders: 0 };
                        if (
                            current.sequence === null ||
                            current.sequence + 1 !== coverage.position
                        )
                            throw new Error("Orderbook sequence gap");
                    }
                    const generation = current.generation + 1;
                    const scopes = bound()
                        .map(
                            (row) =>
                                this.scopes.getCollection(
                                    feed.chainId,
                                    row.collection_id,
                                )!,
                        )
                        .filter(Boolean);
                    const change = db.prepare(
                        "INSERT INTO orderbook_changes(feed_id,generation,native_id,change,observed_ms) VALUES(?,?,?,?,?)",
                    );
                    const upsert =
                        db.prepare(`INSERT INTO orderbook_members(feed_id,native_id,placement,settlement_id,present,eligible,authority,withdrawn,revision,observed_ms,terms,record_json,route_price,collection_id)
                        VALUES(?,?,?,?,1,?,?,?,?,?,?,?,?,?) ON CONFLICT(feed_id,native_id) DO UPDATE SET
                        (placement,settlement_id,present,eligible,authority,withdrawn,revision,observed_ms,terms,record_json,route_price,collection_id)=
                        (excluded.placement,excluded.settlement_id,1,excluded.eligible,excluded.authority,excluded.withdrawn,excluded.revision,excluded.observed_ms,excluded.terms,excluded.record_json,excluded.route_price,excluded.collection_id)`);
                    let activeOrders = 0,
                        deactivatedOrders = 0;
                    eachPage<Staged>(
                        "SELECT * FROM book_stage WHERE run=? AND native_id>? ORDER BY native_id LIMIT ?",
                        [run],
                        "native_id",
                        (row) => {
                            const record: BookObservation = JSON.parse(
                                row.record_json,
                            );
                            const old = this.previousMember.get(
                                id,
                                row.native_id,
                            ) as Member | undefined;
                            if (
                                coverage.kind === "sighting" &&
                                old &&
                                (old.observed_ms >= received ||
                                    (record.sourceTime != null &&
                                        old.source_ms != null &&
                                        record.sourceTime < old.source_ms))
                            )
                                return;
                            const order = record.order;
                            // Whole-market offers can apply to multiple local ranges. Resolve
                            // each local set independently and keep one settlement owner.
                            const offerScopes = order?.sourceSchema
                                ? scopes.flatMap((scope) => {
                                      if (
                                          scope.address.toLowerCase() !==
                                          order.contract.toLowerCase()
                                      )
                                          return [];
                                      const resolved = resolveOrderTokenSet(
                                          this.tokenSets,
                                          {
                                              ...order,
                                              chainId: feed.chainId,
                                              source: record.placement.venue,
                                              rawSourceKind: "rest",
                                              rawPayload: null,
                                          },
                                          scope.id,
                                      );
                                      return resolved.tokenSetId &&
                                          resolved.tokenSetSchemaHash
                                          ? [
                                                {
                                                    collectionId: scope.id,
                                                    tokenSetId:
                                                        resolved.tokenSetId,
                                                    schemaHash:
                                                        resolved.tokenSetSchemaHash,
                                                },
                                            ]
                                          : [];
                                  })
                                : [];
                            const collection =
                                order?.tokenId != null
                                    ? this.scopes.resolveTokenScopedCollectionId(
                                          feed.chainId,
                                          scopes,
                                          order.contract,
                                          order.tokenId,
                                      )
                                    : (offerScopes[0]?.collectionId ??
                                      (scopes.length === 1 &&
                                      order?.contract.toLowerCase() ===
                                          scopes[0]!.address.toLowerCase()
                                          ? scopes[0]!.id
                                          : null));
                            const owns =
                                record.placement.venue === feed.venue &&
                                record.placement.reference === feed.reference;
                            const placement = JSON.stringify([
                                record.placement.chainId,
                                record.placement.venue,
                                record.placement.reference,
                                record.placementOrderId ?? row.native_id,
                            ]);
                            if (!record.fillable && !row.settlement_id) {
                                const related = this.previousPlacementOrder.get(
                                    placement,
                                ) as { settlement_id: string } | undefined;
                                if (related)
                                    dirty.run(run, related.settlement_id);
                            }
                            const price =
                                order?.side === ORDER_SIDE.Buy
                                    ? record.proceeds
                                    : order?.price;
                            const comparable =
                                order?.side !== ORDER_SIDE.Buy ||
                                order.currency?.toLowerCase() ===
                                    this.weth.toLowerCase();
                            upsert.run(
                                id,
                                row.native_id,
                                placement,
                                row.settlement_id,
                                Number(
                                    !!(
                                        price &&
                                        comparable &&
                                        record.fillable &&
                                        collection !== null
                                    ),
                                ),
                                Number(owns),
                                Number(
                                    owns && (!record.fillable || !record.order),
                                ),
                                generation,
                                received,
                                row.terms,
                                row.record_json,
                                price ?? null,
                                collection,
                            );
                            if (
                                order?.sourceSchema ||
                                (old && old.terms !== row.terms)
                            ) {
                                this.clearOfferScopes.run(id, row.native_id);
                                for (const scope of offerScopes) {
                                    this.addOfferScope.run(
                                        id,
                                        row.native_id,
                                        scope.collectionId,
                                        scope.tokenSetId,
                                        scope.schemaHash,
                                    );
                                }
                            }
                            if (!old?.present || old.terms !== row.terms)
                                change.run(
                                    id,
                                    generation,
                                    row.native_id,
                                    old?.present
                                        ? BOOK_CHANGE.Change
                                        : BOOK_CHANGE.Addition,
                                    received,
                                );
                            if (old?.settlement_id)
                                dirty.run(run, old.settlement_id);
                            if (row.settlement_id)
                                dirty.run(run, row.settlement_id);
                            activeOrders++;
                        },
                    );
                    if (
                        coverage.kind === "snapshot" ||
                        coverage.kind === "window" ||
                        (coverage.kind === "sequence" && coverage.baseline)
                    ) {
                        eachPage<{
                            native_id: string;
                            settlement_id: string | null;
                        }>(
                            "SELECT native_id,settlement_id FROM orderbook_members WHERE feed_id=? AND present=1 AND native_id>? AND revision<>" +
                                generation +
                                " ORDER BY native_id LIMIT ?",
                            [id],
                            "native_id",
                            (row) => {
                                this.withdrawMember.run(
                                    Number(coverage.kind !== "window"),
                                    generation,
                                    received,
                                    id,
                                    row.native_id,
                                );
                                change.run(
                                    id,
                                    generation,
                                    row.native_id,
                                    BOOK_CHANGE.Removal,
                                    received,
                                );
                                if (row.settlement_id)
                                    dirty.run(run, row.settlement_id);
                                deactivatedOrders++;
                            },
                        );
                    }
                    if (
                        feed.view === BOOK_VIEW.Public &&
                        coverage.kind === "snapshot"
                    ) {
                        // A REST traversal supersedes earlier OpenSea stream sightings, including
                        // stream-only orders. A later stream delivery keeps its independent evidence.
                        const stream = db
                            .prepare(
                                "SELECT feed_id FROM orderbook_feeds WHERE chain_id=? AND venue=? AND market=? AND contract=? AND view=?",
                            )
                            .get(
                                feed.chainId,
                                feed.venue,
                                feed.reference,
                                feed.contract,
                                BOOK_VIEW.Stream,
                            ) as { feed_id: number } | undefined;
                        if (stream) {
                            db.prepare(
                                "INSERT OR IGNORE INTO book_dirty SELECT ?,settlement_id FROM orderbook_members WHERE feed_id=? AND present=1 AND observed_ms<=? AND settlement_id IS NOT NULL",
                            ).run(run, stream.feed_id, received);
                            db.prepare(
                                "UPDATE orderbook_members SET eligible=0,present=0,withdrawn=0 WHERE feed_id=? AND observed_ms<=? AND present=1",
                            ).run(stream.feed_id, received);
                        }
                    }
                    this.projectOrders(run, feed.chainId, generation, id);
                    db.prepare(
                        "UPDATE orderbook_feeds SET generation=?,accepted_binding_revision=binding_revision,last_success_ms=MAX(COALESCE(last_success_ms,0),?),last_error=NULL,sequence=? WHERE feed_id=?",
                    ).run(
                        generation,
                        received,
                        coverage.kind === "sequence"
                            ? coverage.position
                            : current.sequence,
                        id,
                    );
                    this.invalidateCollections(id);
                    this.refreshDailyPrices(run);
                    return { activeOrders, deactivatedOrders };
                })();
                clear();
                return published;
            },
        };
    }

    private projectOrders(
        run: string,
        chainId: number,
        generation: number,
        feedId: number,
    ) {
        const now = Math.floor(this.clock() / 1000);
        eachPage<{ id: string }>(
            "SELECT id FROM book_dirty WHERE run=? AND id>? ORDER BY id LIMIT ?",
            [run],
            "id",
            (row) =>
                this.project(run, chainId, row.id, now, generation, feedId),
        );
    }

    private refreshDailyPrices(run: string) {
        // The writer lock freezes competing publications and chain updates. Time
        // can still cross midnight or the validity boundary of a competing ask.
        // Page the affected sellers by their temporary primary key. Each seller
        // looks up its own daily row, including for a single stream observation.
        const sellers = db.raw.prepare(
            `SELECT chain_id,collection_id,token_id,maker FROM book_sellers WHERE run=@run
             AND (chain_id,collection_id,token_id,maker)>(@chain_id,@collection_id,@token_id,@maker)
             ORDER BY chain_id,collection_id,token_id,maker LIMIT @limit`,
        );
        const writeDailyPrices = db.writeTransaction(() => {
            const start = Math.floor(this.clock() / 1000);
            const day = Math.floor(start / POLICY.utcDaySeconds);
            let after: Scope = {
                chain_id: -1,
                collection_id: -1,
                token_id: "",
                maker: "",
            };
            for (;;) {
                const page = sellers.all({
                    run,
                    limit: BATCH,
                    ...after,
                }) as Scope[];
                if (!page.length) break;
                for (const seller of page)
                    this.history.refreshSeller(seller, start);
                after = page[page.length - 1]!;
            }
            const end = Math.floor(this.clock() / 1000);
            if (
                end !== start &&
                (end < start ||
                    Math.floor(end / POLICY.utcDaySeconds) !== day ||
                    this.crossedAskBoundary.get({
                        run,
                        day,
                        start,
                        end,
                        sell: ORDER_SIDE.Sell,
                    }))
            )
                throw new ListingPriceTimeChanged(
                    "Listing price validity changed during publication",
                );
        });
        try {
            writeDailyPrices();
        } catch (error) {
            if (!(error instanceof ListingPriceTimeChanged)) throw error;
            // One savepoint retry keeps the staged membership. A second crossing
            // releases the writer and lets the normal venue retry start fresh.
            writeDailyPrices();
        }
    }

    /** Removing one association can uncover an independent venue's route. */
    unbind(feed: BookFeed, collectionId: number) {
        db.writeTransaction(() => {
            const state = this.state(feed);
            const run = randomUUID();
            const removed = db
                .prepare(
                    "DELETE FROM orderbook_bindings WHERE feed_id=? AND collection_id=?",
                )
                .run(state.feed_id, collectionId);
            if (!removed.changes) return;
            db.prepare(
                "INSERT OR IGNORE INTO book_dirty SELECT ?,settlement_id FROM orderbook_members WHERE feed_id=? AND collection_id=? AND settlement_id IS NOT NULL",
            ).run(run, state.feed_id, collectionId);
            db.prepare(
                "UPDATE orderbook_members SET collection_id=NULL,eligible=0 WHERE feed_id=? AND collection_id=?",
            ).run(state.feed_id, collectionId);
            this.projectOrders(
                run,
                feed.chainId,
                state.generation,
                state.feed_id,
            );
            db.prepare("DELETE FROM book_dirty WHERE run=?").run(run);
            db.prepare(
                "UPDATE collections SET market_revision=market_revision+1 WHERE collection_id=?",
            ).run(collectionId);
            this.refreshDailyPrices(run);
            db.prepare("DELETE FROM book_sellers WHERE run=?").run(run);
        })();
    }

    private invalidateCollections(feedId: number) {
        db.prepare(
            "UPDATE collections SET market_revision=market_revision+1 WHERE collection_id IN (SELECT collection_id FROM orderbook_bindings WHERE feed_id=?)",
        ).run(feedId);
    }

    private project(
        run: string,
        chainId: number,
        settlement: string,
        now: number,
        generation: number,
        feedId: number,
    ) {
        const seller = () =>
            this.markSeller.run(run, settlement, ORDER_SIDE.Sell);
        seller();
        const winner = this.winningRoute.get(settlement) as Route | undefined;
        if (!winner) {
            this.deactivateOrder.run(
                ORDER_SOURCE_STATUS.Inactive,
                settlement,
                ORDER_SOURCE_STATUS.Active,
            );
            return;
        }
        const record: BookObservation = JSON.parse(winner.record_json);
        const order = record.order!;
        const normalized = {
            ...order,
            chainId,
            source: record.placement.venue,
            rawSourceKind: "rest" as const,
            rawPayload: null,
            orderId: settlement,
        };
        const local = order.sourceSchema
            ? (this.localOfferScope.get(
                  winner.feed_id,
                  winner.native_id,
                  winner.collection_id,
              ) as { token_set_id: string; schema_hash: string } | undefined)
            : undefined;
        const payload = makeOrderUpsert(
            this.tokenSets,
            normalized,
            winner.collection_id,
            now,
            local
                ? {
                      localTokenSetStatus:
                          ORDER_LOCAL_TOKEN_SET_STATUS.Resolved,
                      tokenSetId: local.token_set_id,
                      tokenSetSchemaHash: local.schema_hash,
                  }
                : undefined,
        );
        const result = this.projection.applyOrderUpsert(payload, false);
        this.publishWinner.run(
            order.orderId,
            winner.feed_id,
            winner.native_id,
            record.fees,
            record.proceeds,
            settlement,
        );
        if (result.validationNeeded) {
            const validation = {
                chainId,
                orderId: settlement,
                reason: ORDER_UPDATE_REASON.Validation,
            };
            this.outbox.enqueueRequiredJob({
                jobId: [
                    "book",
                    feedId,
                    generation,
                    settlement,
                    result.validationRevision,
                ].join(":"),
                kind: ORDER_JOB_KIND.UpdateById,
                queue: orderUpdateQueue(validation),
                chainId,
                collectionId: winner.collection_id,
                attempt: 0,
                scheduledAt: now * 1000,
                payload: validation,
            });
        }
        seller();
    }
}

function eachPage<T>(
    sql: string,
    args: (string | number)[],
    key: keyof T,
    visit: (row: T) => void,
) {
    const select = db.raw.prepare(sql);
    let after = "";
    for (;;) {
        const rows = select.all(...args, after, BATCH) as T[];
        if (!rows.length) return;
        for (const row of rows) visit(row);
        after = String(rows[rows.length - 1]![key]);
    }
}
