import {
    buildCatalogTokenPredicate,
    withTraitReadSnapshot,
    catalogViewIds,
} from "@artgod/shared/read-models/trait-catalog";
import {
    groupTraitFilters,
    groupTraitRangeFilters,
} from "@artgod/shared/read-models/trait-filters";
import type {
    TraitFilter,
    TraitRangeFilter,
} from "@artgod/shared/types/browse";
import type { TraitReadContext } from "@artgod/shared/types/trait-catalog";
import type { PersistedBiddingJobRecord } from "@artgod/shared/types";
import { db } from "@artgod/shared/database";
import { CANONICAL_TRAIT_RELATION_SQL } from "@artgod/shared/database/canonical-traits";
import {
    biddingTraitCriteriaKey,
    biddingTraitsMatchToken,
} from "@artgod/shared/trading/offer-trait-criteria";
import { parseOpenSeaTokenIdRanges } from "@artgod/shared/trading/open-sea-bidding-offers";
import {
    TRADING_BIDDING_BID_SCOPE_KIND as SCOPE,
    COLLECTION_STATUS,
    type TradingBiddingTraitCriterion,
    type TradingTraitCriterion,
} from "@artgod/shared/types";
import { TOKEN_RECORD_KIND } from "@artgod/shared/types/token-records";
import {
    VIEW_OFFER_APPLICABILITY as RESULT,
    type ViewOfferApplicability,
} from "@artgod/shared/types/trait-catalog";
import type { PersistedBiddingBidBookRow } from "../../application/use-cases/trading/bidding-bid-book.js";

/** The caller holds a read snapshot. Resolve each distinct native scope once across market bids and own declarations. */
type NativeScope = Pick<
    PersistedBiddingBidBookRow,
    "scopeKind" | "scopeTraits" | "encodedTokenIds" | "tokenId"
>;
function viewOfferMatcher(
    chainId: number,
    collectionId: number,
    views: NonNullable<ReturnType<typeof catalogViewIds>>,
) {
    const cache = new Map<string, ViewOfferApplicability | null>();
    const scope = [chainId, collectionId] as const;
    let incomplete: boolean | undefined;
    function incompleteCoverage(): boolean {
        // A mint may have ownership before any metadata. A pending observation or
        // unresolved classification can still reveal membership in this view.
        return (incomplete ??= Boolean(
            db
                .prepare(
                    `
            SELECT 1 WHERE EXISTS(SELECT 1 FROM collections WHERE chain_id=? AND collection_id=? AND status<>?)
            OR EXISTS(SELECT 1 FROM metadata_pending WHERE chain_id=? AND collection_id=?)
            OR EXISTS(SELECT 1 FROM tokens t LEFT JOIN trait_catalog_members m USING(chain_id,collection_id,token_id)
                WHERE t.chain_id=? AND t.collection_id=? AND t.record_kind=? AND m.scope_key IS NULL)
            OR EXISTS(SELECT 1 FROM nft_balances b LEFT JOIN trait_catalog_members m USING(chain_id,collection_id,token_id)
                WHERE b.chain_id=? AND b.collection_id=? AND b.amount!='0' AND m.scope_key IS NULL)
        `,
                )
                .get(
                    ...scope,
                    COLLECTION_STATUS.Live,
                    ...scope,
                    ...scope,
                    TOKEN_RECORD_KIND.Canonical,
                    ...scope,
                ),
        ));
    }
    function exactToken(id: string): ViewOfferApplicability | null {
        const member = db
            .prepare(
                `SELECT view_id IN (${views.sql}) AS matched,scope_key FROM trait_catalog_members WHERE chain_id=? AND collection_id=? AND token_id=?`,
            )
            .get(...views.values, ...scope, id) as
            | { matched: number | null; scope_key: string | null }
            | undefined;
        if (member?.matched) return RESULT.Matched;
        return member?.scope_key ? null : RESULT.Unresolved;
    }
    function finite(encoded: string): ViewOfferApplicability | null {
        const ranges = parseOpenSeaTokenIdRanges(encoded);
        if (!ranges) return RESULT.Unresolved;
        let missing = false;
        const count = db.prepare(`
            SELECT COUNT(DISTINCT CASE WHEN m.scope_key IS NOT NULL THEN t.token_sort_value END) AS known,
                   MAX(m.view_id IN (${views.sql})) AS matched
            FROM tokens t JOIN trait_catalog_members m USING(chain_id,collection_id,token_id)
            WHERE t.chain_id=? AND t.collection_id=? AND t.token_sort_bucket=0
                AND (t.token_sort_length,t.token_sort_value)>=(?,?) AND (t.token_sort_length,t.token_sort_value)<=(?,?)
        `);
        for (const range of ranges) {
            const start = range.start.toString(),
                end = range.end.toString();
            const row = count.get(
                ...views.values,
                ...scope,
                start.length,
                start,
                end.length,
                end,
            ) as { known: number; matched: number | null };
            if (row.matched) return RESULT.Matched;
            if (BigInt(row.known) < range.end - range.start + 1n)
                missing = true;
        }
        return missing ? RESULT.Unresolved : null;
    }
    function traitScope(
        criteria: TradingBiddingTraitCriterion[],
    ): ViewOfferApplicability | null {
        if (!criteria.length) return RESULT.Unresolved;
        // Stream only the required canonical keys. Multiple values on one token
        // stay associated, and the native matcher owns numeric/exact semantics.
        const keys = [...new Set(criteria.map((c) => c.type))];
        const stream = db
            .prepare(
                `
            SELECT m.token_id,f.key AS type,f.value FROM trait_catalog_members m
            JOIN (${CANONICAL_TRAIT_RELATION_SQL}) f USING(chain_id,collection_id,token_id)
            WHERE m.chain_id=? AND m.collection_id=? AND m.view_id IN (${views.sql}) AND f.key IN(SELECT value FROM json_each(?))
            ORDER BY m.token_id
        `,
            )
            .iterate(
                ...scope,
                ...views.values,
                JSON.stringify(keys),
            ) as Iterable<{
            token_id: string;
            type: string;
            value: string;
        }>;
        let tokenId: string | null = null;
        let facts: TradingTraitCriterion[] = [];
        for (const row of stream) {
            if (row.token_id !== tokenId) {
                if (facts.length && biddingTraitsMatchToken(criteria, facts))
                    return RESULT.Matched;
                tokenId = row.token_id;
                facts = [];
            }
            facts.push(row);
        }
        if (facts.length && biddingTraitsMatchToken(criteria, facts))
            return RESULT.Matched;
        return incompleteCoverage() ? RESULT.Unresolved : null;
    }
    function applicability(row: NativeScope): ViewOfferApplicability | null {
        if (row.scopeKind === SCOPE.Token)
            return row.tokenId === null
                ? RESULT.Unresolved
                : exactToken(row.tokenId);
        if (row.encodedTokenIds && row.encodedTokenIds !== "*")
            return finite(row.encodedTokenIds);
        if (row.scopeKind === SCOPE.Collection) return RESULT.Matched;
        if (row.scopeKind === SCOPE.Trait) return traitScope(row.scopeTraits);
        return RESULT.Unresolved;
    }
    return (row: NativeScope) => {
        const key = JSON.stringify([
            row.scopeKind,
            row.tokenId,
            row.encodedTokenIds,
            biddingTraitCriteriaKey(row.scopeTraits),
        ]);
        if (!cache.has(key)) cache.set(key, applicability(row));
        return cache.get(key);
    };
}

export function scopeBidsToCollectionView(
    chainId: number,
    collectionId: number,
    views: NonNullable<ReturnType<typeof catalogViewIds>>,
    rows: PersistedBiddingBidBookRow[],
): PersistedBiddingBidBookRow[] {
    const matches = viewOfferMatcher(chainId, collectionId, views);
    return rows.flatMap((row) => {
        const viewApplicability = matches(row);
        return viewApplicability ? [{ ...row, viewApplicability }] : [];
    });
}

/** Select known token cards in the same catalog snapshot as the offers, before counting or paging them. */
export function filterCatalogTokenBids(
    params: {
        chainId: number;
        collectionId: number;
        traitContext: TraitReadContext;
        selectedTraits: TraitFilter[];
        selectedTraitRanges: TraitRangeFilter[];
    },
    bids: PersistedBiddingBidBookRow[],
): PersistedBiddingBidBookRow[] {
    if (!bids.length) return [];
    const predicate = buildCatalogTokenPredicate({
        ...params,
        tokenColumnSql: "t.token_id",
        traitFilterGroups: groupTraitFilters(params.selectedTraits),
        traitRangeFilterGroups: groupTraitRangeFilters(
            params.selectedTraitRanges,
        ),
    });
    const tokenIds = new Set(bids.map((bid) => bid.tokenId));
    const matchingIds = new Set(
        db.raw
            .prepare(
                `SELECT t.token_id FROM tokens t WHERE t.chain_id=? AND t.collection_id=?
         AND t.token_id IN (SELECT value FROM json_each(?)) AND ${predicate.sql}`,
            )
            .pluck()
            .iterate(
                params.chainId,
                params.collectionId,
                JSON.stringify([...tokenIds]),
                ...predicate.values,
            ),
    );
    const matched = bids.filter((bid) => matchingIds.has(bid.tokenId));
    return params.traitContext.viewId || params.traitContext.groupId
        ? matched.map((bid) => ({ ...bid, viewApplicability: RESULT.Matched }))
        : matched;
}

/** A view-scoped job-selection preview may preselect only established members. Direct job-ID management remains available. */
export function readJobsForView<T extends PersistedBiddingJobRecord>(
    params: {
        chainId: number;
        collectionId: number;
        traitContext?: TraitReadContext;
    },
    load: () => T[],
): T[] {
    const traitContext = params.traitContext;
    const views = catalogViewIds(
        params.chainId,
        params.collectionId,
        traitContext,
    );
    if (!views || !traitContext) return load();
    return withTraitReadSnapshot({ ...params, traitContext }, () => {
        const match = viewOfferMatcher(
            params.chainId,
            params.collectionId,
            views,
        );
        return load().filter(
            (job) =>
                match({
                    scopeKind:
                        job.tokenId !== null
                            ? SCOPE.Token
                            : job.targetTraits.length
                              ? SCOPE.Trait
                              : SCOPE.Collection,
                    scopeTraits: job.targetTraits,
                    tokenId: job.tokenId,
                    encodedTokenIds: null,
                }) === RESULT.Matched,
        );
    });
}
