import { db } from "../database/db.js";
import { MAX_PAGE_LIMIT } from "../config/pagination.js";
import {
    NOOP_APM,
    type ApmPort,
    type SpanAttributes,
} from "../observability/apm.js";
import type {
    CollectionHolder,
    CollectionHolderPage,
    CollectionListCursor,
    CollectionListItem,
    CursorPage,
    TokenCard,
    TokenBrowserStatus,
    TokenDetail,
    TokenDetailTrait,
    TokenMediaPreview,
    TokenCursorPage,
    TokenCursor,
    TokenAttribute,
    TraitFacet,
    TraitFilter,
    TraitRangeFilter,
} from "../types/browse.js";
import {
    normalizeTraitKeyList,
    TRAIT_FILTER_DISPLAY_KIND,
    type TraitFilterPresentationConfig,
} from "../types/customization.js";
import { decodeOpaqueCursor, encodeOpaqueCursor } from "../utils/cursor.js";
import {
    normalizeAddressRef,
    normalizeSlugRef,
} from "../utils/ref-resolver.js";
import { ReadModelBadRequestError, ReadModelNotFoundError } from "./errors.js";
import {
    buildTokenTraitFilterWhereClauses,
    buildTokenTraitRangeJoinClauses,
    groupTraitFilters,
    groupTraitRangeFilters,
    normalizeTraitFilters,
    normalizeTraitRangeFilters,
    type TraitFilterGroup,
    type TraitRangeFilterGroup,
} from "./trait-filters.js";

type CollectionRow = {
    chain_id: number;
    collection_id: number;
    slug: string;
    address: string;
    standard: string;
    status: string;
    deployment_block: number | null;
    bootstrap_anchor_block: number | null;
    created_at: string;
    updated_at: string;
};

type TokenRow = {
    token_id: string;
    name: string | null;
    image: string | null;
    listing_price: string | null;
    listing_currency: string | null;
    attributes_json: string | null;
    metadata_updated_at: string | null;
};

type TokenDetailRow = {
    token_id: string;
    name: string | null;
    image: string | null;
    animation_url: string | null;
    listing_price: string | null;
    listing_currency: string | null;
    attributes_json: string | null;
    metadata_updated_at: string | null;
};

type TokenPreviewRow = {
    token_id: string;
    image: string | null;
    animation_url: string | null;
};

type TokenIdRow = {
    token_id: string;
};

type TokenListingRow = {
    token_id: string;
    listing_price: string | null;
};

type TokenCurrentHolderRow = {
    owner: string;
};

type TraitFacetRow = {
    key: string;
    value: string;
    token_count: number;
};

type HolderRow = {
    owner: string | null;
    token_count: string | null;
    held_percent: number | null;
    row_num: number | null;
    total_count: number;
};

type TokenDetailTraitRow = {
    key: string;
    value: string;
    token_count: number | null;
};

type TokenSortKey = {
    tokenId: string;
    bucket: number;
    length: number;
    value: string;
};

type ListingPriceSortKey = {
    raw: string;
    length: number;
    value: string;
};

type ListingCursorKey = {
    price: ListingPriceSortKey;
    token: TokenSortKey;
};

type ListedThenUnlistedCursorKey = {
    block: number;
    priceLength: number;
    priceValue: string;
    token: TokenSortKey;
    tokenId: string;
    listingPrice: string | null;
};

type HolderCountSortKey = {
    raw: string;
    length: number;
    value: string;
};

type HolderCursor = {
    tokenCount: string;
    owner: string;
};

type HolderCursorKey = {
    count: HolderCountSortKey;
    owner: string;
};

const TOKEN_ID_IS_NUMERIC_SQL =
    "t.token_id <> '' AND t.token_id NOT GLOB '*[^0-9]*'";
const TOKEN_ID_NORMALIZED_NUMERIC_SQL =
    "CASE WHEN LTRIM(t.token_id, '0') = '' THEN '0' ELSE LTRIM(t.token_id, '0') END";
const TOKEN_SORT_BUCKET_SQL = `CASE WHEN ${TOKEN_ID_IS_NUMERIC_SQL} THEN 0 ELSE 1 END`;
const TOKEN_SORT_LENGTH_SQL = `CASE WHEN ${TOKEN_ID_IS_NUMERIC_SQL} THEN LENGTH(${TOKEN_ID_NORMALIZED_NUMERIC_SQL}) ELSE 0 END`;
const TOKEN_SORT_VALUE_SQL = `CASE WHEN ${TOKEN_ID_IS_NUMERIC_SQL} THEN ${TOKEN_ID_NORMALIZED_NUMERIC_SQL} ELSE t.token_id END`;
const TOKEN_SORT_KEY_SQL = `(${TOKEN_SORT_BUCKET_SQL}, ${TOKEN_SORT_LENGTH_SQL}, ${TOKEN_SORT_VALUE_SQL}, t.token_id)`;
const TOKEN_ORDER_BY_ASC_SQL = `${TOKEN_SORT_BUCKET_SQL} ASC, ${TOKEN_SORT_LENGTH_SQL} ASC, ${TOKEN_SORT_VALUE_SQL} ASC, t.token_id ASC`;
const TOKEN_ORDER_BY_DESC_SQL = `${TOKEN_SORT_BUCKET_SQL} DESC, ${TOKEN_SORT_LENGTH_SQL} DESC, ${TOKEN_SORT_VALUE_SQL} DESC, t.token_id DESC`;
const LISTING_PRICE_IS_NUMERIC_SQL =
    "o.price IS NOT NULL AND o.price <> '' AND o.price NOT GLOB '*[^0-9]*'";
const LISTING_PRICE_NORMALIZED_SQL =
    "CASE WHEN LTRIM(o.price, '0') = '' THEN '0' ELSE LTRIM(o.price, '0') END";
const LISTING_PRICE_LENGTH_SQL = `LENGTH(${LISTING_PRICE_NORMALIZED_SQL})`;
const LISTED_TOKEN_SORT_KEY_SQL = `(l.price_sort_length, l.price_sort_value, ${TOKEN_SORT_BUCKET_SQL}, ${TOKEN_SORT_LENGTH_SQL}, ${TOKEN_SORT_VALUE_SQL}, t.token_id)`;
const LISTED_ORDER_BY_ASC_SQL = `l.price_sort_length ASC, l.price_sort_value ASC, ${TOKEN_ORDER_BY_ASC_SQL}`;
const LISTED_ORDER_BY_DESC_SQL = `l.price_sort_length DESC, l.price_sort_value DESC, ${TOKEN_ORDER_BY_DESC_SQL}`;
const LISTED_THEN_UNLISTED_BLOCK_SQL =
    "CASE WHEN l.price IS NULL THEN 1 ELSE 0 END";
const LISTED_THEN_UNLISTED_PRICE_LENGTH_SQL =
    "CASE WHEN l.price IS NULL THEN 0 ELSE l.price_sort_length END";
const LISTED_THEN_UNLISTED_PRICE_VALUE_SQL =
    "CASE WHEN l.price IS NULL THEN '' ELSE l.price_sort_value END";
const LISTED_THEN_UNLISTED_TOKEN_SORT_KEY_SQL = `(${LISTED_THEN_UNLISTED_BLOCK_SQL}, ${LISTED_THEN_UNLISTED_PRICE_LENGTH_SQL}, ${LISTED_THEN_UNLISTED_PRICE_VALUE_SQL}, ${TOKEN_SORT_BUCKET_SQL}, ${TOKEN_SORT_LENGTH_SQL}, ${TOKEN_SORT_VALUE_SQL}, t.token_id)`;
const LISTED_THEN_UNLISTED_ORDER_BY_ASC_SQL = `${LISTED_THEN_UNLISTED_BLOCK_SQL} ASC, ${LISTED_THEN_UNLISTED_PRICE_LENGTH_SQL} ASC, ${LISTED_THEN_UNLISTED_PRICE_VALUE_SQL} ASC, ${TOKEN_ORDER_BY_ASC_SQL}`;
const LISTED_THEN_UNLISTED_ORDER_BY_DESC_SQL = `${LISTED_THEN_UNLISTED_BLOCK_SQL} DESC, ${LISTED_THEN_UNLISTED_PRICE_LENGTH_SQL} DESC, ${LISTED_THEN_UNLISTED_PRICE_VALUE_SQL} DESC, ${TOKEN_ORDER_BY_DESC_SQL}`;

export type ListCollectionsParams = {
    chainId: number;
    status?: "bootstrapping" | "live" | "paused" | "disabled";
    limit: number;
    cursor?: string;
};

export type ListCollectionTokensParams = {
    chainId: number;
    collectionId: number;
    tokenStatus: TokenBrowserStatus;
    limit: number;
    cursor?: string;
    traitFilters?: TraitFilter[];
    traitRangeFilters?: TraitRangeFilter[];
    owner?: string;
};

export type ListCollectionTraitFacetsOptions = {
    excludeKeys?: string[];
};

export type GetCollectionTokenDetailParams = {
    chainId: number;
    collectionId: number;
    tokenId: string;
};

export type ListCollectionTokenCardsByIdsParams = {
    chainId: number;
    collectionId: number;
    tokenIds: string[];
    includeListings?: boolean;
};

export type ListCollectionHoldersParams = {
    chainId: number;
    collectionId: number;
    limit: number;
    cursor?: string;
};

export class SqliteCollectionsReadModel {
    private readonly supportedListingCurrencies: string[];

    constructor(
        supportedListingCurrencies: string[],
        private readonly apm: ApmPort = NOOP_APM,
    ) {
        const normalized = [
            ...new Set(
                supportedListingCurrencies.map((value) =>
                    normalizeAddressRef(value),
                ),
            ),
        ];
        if (normalized.length === 0) {
            throw new Error(
                "SqliteCollectionsReadModel requires supported listing currencies",
            );
        }
        this.supportedListingCurrencies = normalized;
    }

    private selectCollectionBySlug = db.prepare<{
        chainId: number;
        slug: string;
    }>(
        "SELECT chain_id, collection_id, slug, address, standard, status, deployment_block, bootstrap_anchor_block, created_at, updated_at " +
            "FROM collections " +
            "WHERE chain_id = @chainId AND slug = @slug " +
            "LIMIT 1",
    );

    private selectTraitFacetRows = db.prepare<[number, number]>(
        "SELECT attribute_keys.key as key, attributes.value as value, collection_trait_stats.token_count as token_count " +
            "FROM collection_trait_stats " +
            "JOIN attributes ON attributes.id = collection_trait_stats.attribute_id " +
            "AND attributes.chain_id = collection_trait_stats.chain_id " +
            "AND attributes.collection_id = collection_trait_stats.collection_id " +
            "JOIN attribute_keys ON attribute_keys.id = collection_trait_stats.attribute_key_id " +
            "AND attribute_keys.chain_id = collection_trait_stats.chain_id " +
            "AND attribute_keys.collection_id = collection_trait_stats.collection_id " +
            "WHERE collection_trait_stats.chain_id = ? AND collection_trait_stats.collection_id = ? " +
            "ORDER BY attribute_keys.key ASC, collection_trait_stats.token_count ASC, attributes.value ASC",
    );

    private selectOwnerScopedTraitFacetRows = db.prepare<
        [number, number, string]
    >(
        "SELECT ak.key AS key, a.value AS value, COUNT(*) AS token_count " +
            "FROM token_attributes ta " +
            "JOIN attributes a ON a.id = ta.attribute_id " +
            "AND a.chain_id = ta.chain_id " +
            "AND a.collection_id = ta.collection_id " +
            "JOIN attribute_keys ak ON ak.id = a.attribute_key_id " +
            "AND ak.chain_id = a.chain_id " +
            "AND ak.collection_id = a.collection_id " +
            "WHERE ta.chain_id = ? " +
            "AND ta.collection_id = ? " +
            "AND EXISTS ( " +
            "SELECT 1 FROM nft_balances b " +
            "WHERE b.chain_id = ta.chain_id " +
            "AND b.collection_id = ta.collection_id " +
            "AND b.token_id = ta.token_id " +
            "AND lower(b.owner) = ? " +
            "AND CAST(b.amount AS INTEGER) > 0" +
            ") " +
            "GROUP BY ak.key, a.value " +
            "ORDER BY ak.key ASC, token_count ASC, a.value ASC",
    );

    private selectTokenCurrentHolderRow = db.prepare<[number, number, string]>(
        "SELECT lower(owner) AS owner " +
            "FROM nft_balances " +
            "WHERE chain_id = ? AND collection_id = ? AND token_id = ? " +
            "AND CAST(amount AS INTEGER) > 0 " +
            "ORDER BY lower(owner) ASC " +
            "LIMIT 1",
    );

    private selectTokenDetailTraitRows = db.prepare<[number, number, string]>(
        "SELECT ak.key AS key, a.value AS value, cts.token_count AS token_count " +
            "FROM token_attributes ta " +
            "JOIN attributes a ON a.id = ta.attribute_id " +
            "AND a.chain_id = ta.chain_id " +
            "AND a.collection_id = ta.collection_id " +
            "JOIN attribute_keys ak ON ak.id = a.attribute_key_id " +
            "AND ak.chain_id = a.chain_id " +
            "AND ak.collection_id = a.collection_id " +
            "LEFT JOIN collection_trait_stats cts ON cts.chain_id = ta.chain_id " +
            "AND cts.collection_id = ta.collection_id " +
            "AND cts.attribute_key_id = a.attribute_key_id " +
            "AND cts.attribute_id = a.id " +
            "WHERE ta.chain_id = ? AND ta.collection_id = ? AND ta.token_id = ? " +
            "ORDER BY ak.key ASC, a.value ASC",
    );

    private selectTokenPreviewRow = db.prepare<{
        chainId: number;
        collectionId: number;
        tokenId: string;
    }>(
        "SELECT t.token_id, m.image, m.animation_url " +
            "FROM tokens t " +
            "LEFT JOIN token_metadata m ON m.chain_id = t.chain_id " +
            "AND m.collection_id = t.collection_id " +
            "AND m.token_id = t.token_id " +
            "WHERE t.chain_id = @chainId AND t.collection_id = @collectionId AND t.token_id = @tokenId " +
            "LIMIT 1",
    );

    listCollections(
        params: ListCollectionsParams,
    ): CursorPage<CollectionListItem> {
        const limit = normalizeLimit(params.limit);
        const cursor =
            params.cursor !== undefined
                ? decodeCollectionCursor(params.cursor)
                : null;

        const whereClauses: string[] = ["chain_id = ?"];
        const values: unknown[] = [params.chainId];

        if (params.status) {
            whereClauses.push("status = ?");
            values.push(params.status);
        }

        if (cursor) {
            whereClauses.push(
                "(created_at < ? OR (created_at = ? AND slug > ?))",
            );
            values.push(cursor.createdAt, cursor.createdAt, cursor.slug);
        }

        const sql =
            "SELECT chain_id, collection_id, slug, address, standard, status, deployment_block, bootstrap_anchor_block, created_at, updated_at " +
            "FROM collections " +
            `WHERE ${whereClauses.join(" AND ")} ` +
            "ORDER BY created_at DESC, slug ASC " +
            "LIMIT ?";

        values.push(limit + 1);

        const rows = db.raw.prepare(sql).all(...values) as CollectionRow[];
        const hasNext = rows.length > limit;
        const pageRows = hasNext ? rows.slice(0, limit) : rows;
        const items = pageRows.map(mapCollectionRow);

        const nextCursor = hasNext
            ? encodeOpaqueCursor({
                  createdAt: pageRows[pageRows.length - 1]!.created_at,
                  slug: pageRows[pageRows.length - 1]!.slug,
              })
            : null;

        return {
            items,
            nextCursor,
            limit,
        };
    }

    resolveCollectionRef(
        chainId: number,
        collectionRef: string,
    ): CollectionListItem {
        const ref = collectionRef.trim();
        let row: CollectionRow | undefined;

        if (!ref) {
            throw new ReadModelBadRequestError("Invalid collection_ref");
        }
        row = this.selectCollectionBySlug.get({
            chainId,
            slug: normalizeSlugRef(ref),
        }) as CollectionRow | undefined;

        if (!row) {
            throw new ReadModelNotFoundError("Unknown collection_ref");
        }

        return mapCollectionRow(row);
    }

    listCollectionTokens(params: ListCollectionTokensParams): TokenCursorPage {
        const limit = normalizeLimit(params.limit);
        const cursor =
            params.cursor !== undefined
                ? decodeTokenCursor(params.cursor)
                : null;
        const nowSeconds = Math.floor(Date.now() / 1000);
        const traitFilterGroups = groupTraitFilters(
            normalizeTraitFilters(params.traitFilters ?? []),
        );
        const traitRangeFilterGroups = groupTraitRangeFilters(
            normalizeTraitRangeFilters(params.traitRangeFilters ?? []),
        );
        const owner = params.owner
            ? normalizeAddressRef(params.owner)
            : undefined;

        if (params.tokenStatus === "listed") {
            if (cursor && cursor.kind !== "listed") {
                throw new ReadModelBadRequestError("Invalid cursor");
            }
            return this.listListedCollectionTokens({
                chainId: params.chainId,
                collectionId: params.collectionId,
                limit,
                nowSeconds,
                cursor,
                traitFilterGroups,
                traitRangeFilterGroups,
                owner,
            });
        }

        if (params.tokenStatus === "listed_then_unlisted") {
            if (cursor && cursor.kind !== "listed_then_unlisted") {
                throw new ReadModelBadRequestError("Invalid cursor");
            }
            return this.listListedThenUnlistedCollectionTokens({
                chainId: params.chainId,
                collectionId: params.collectionId,
                limit,
                nowSeconds,
                cursor,
                traitFilterGroups,
                traitRangeFilterGroups,
                owner,
            });
        }

        if (cursor && cursor.kind !== "all") {
            throw new ReadModelBadRequestError("Invalid cursor");
        }

        return this.listAllCollectionTokens({
            chainId: params.chainId,
            collectionId: params.collectionId,
            limit,
            nowSeconds,
            cursor,
            traitFilterGroups,
            traitRangeFilterGroups,
            owner,
        });
    }

    private listAllCollectionTokens(params: {
        chainId: number;
        collectionId: number;
        limit: number;
        nowSeconds: number;
        cursor: Extract<TokenCursor, { kind: "all" }> | null;
        traitFilterGroups: TraitFilterGroup[];
        traitRangeFilterGroups: TraitRangeFilterGroup[];
        owner?: string;
    }): TokenCursorPage {
        const spanAttributes = buildTokenQuerySpanAttributes({
            chainId: params.chainId,
            collectionId: params.collectionId,
            tokenStatus: "all",
            limit: params.limit,
            cursorPresent: Boolean(params.cursor),
            traitFilterGroups: params.traitFilterGroups,
            traitRangeFilterGroups: params.traitRangeFilterGroups,
            owner: params.owner,
        });
        const {
            baseJoinClauses,
            baseJoinValues,
            baseWhereClauses,
            baseWhereValues,
        } = buildTokenQueryParts({
            chainId: params.chainId,
            collectionId: params.collectionId,
            traitFilterGroups: params.traitFilterGroups,
            traitRangeFilterGroups: params.traitRangeFilterGroups,
            owner: params.owner,
        });
        const cursorSortKey = params.cursor
            ? toTokenSortKey(params.cursor.tokenId)
            : null;
        const whereClauses = [...baseWhereClauses];
        const values = [
            ...baseJoinValues,
            ...buildCheapestListingValues({
                chainId: params.chainId,
                collectionId: params.collectionId,
                supportedCurrencies: this.supportedListingCurrencies,
                nowSeconds: params.nowSeconds,
            }),
            ...baseWhereValues,
        ];

        if (cursorSortKey) {
            whereClauses.push(`${TOKEN_SORT_KEY_SQL} > (?, ?, ?, ?)`);
            values.push(...tokenSortKeyParams(cursorSortKey));
        }

        const sql =
            "SELECT t.token_id, m.name, m.image, l.price AS listing_price, l.currency AS listing_currency, m.attributes_json, m.updated_at AS metadata_updated_at " +
            "FROM tokens t " +
            `${baseJoinClauses.join(" ")} ` +
            "LEFT JOIN token_metadata m ON m.chain_id = t.chain_id " +
            "AND m.collection_id = t.collection_id " +
            "AND m.token_id = t.token_id " +
            `LEFT JOIN (${buildCheapestListingSql(this.supportedListingCurrencies.length)}) l ` +
            "ON l.collection_id = t.collection_id " +
            "AND l.token_id = t.token_id " +
            `WHERE ${whereClauses.join(" AND ")} ` +
            `ORDER BY ${TOKEN_ORDER_BY_ASC_SQL} ` +
            "LIMIT ?";

        values.push(params.limit + 1);

        const rows = this.apm.withSyncSpan(
            "backend.collection.db.tokens_page",
            spanAttributes,
            () => db.raw.prepare(sql).all(...values) as TokenRow[],
        );
        const hasNext = rows.length > params.limit;
        const pageRows = hasNext ? rows.slice(0, params.limit) : rows;
        const items = pageRows.map(mapTokenRow);

        const prevCursor = params.cursor
            ? this.apm.withSyncSpan(
                  "backend.collection.db.tokens_prev_cursor",
                  spanAttributes,
                  () =>
                      derivePrevCursor({
                          baseJoinClauses,
                          baseJoinValues,
                          baseWhereClauses,
                          baseWhereValues,
                          cursor: params.cursor,
                          pageRows,
                          limit: params.limit,
                      }),
              )
            : null;

        const totalItems = this.apm.withSyncSpan(
            "backend.collection.db.tokens_count",
            {
                ...spanAttributes,
                "artgod.collection.count_kind": "total",
            },
            () =>
                countMatchingTokens({
                    joinClauses: baseJoinClauses,
                    joinValues: baseJoinValues,
                    whereClauses: baseWhereClauses,
                    whereValues: baseWhereValues,
                }),
        );
        const beforeItems = cursorSortKey
            ? this.apm.withSyncSpan(
                  "backend.collection.db.tokens_count",
                  {
                      ...spanAttributes,
                      "artgod.collection.count_kind": "before_cursor",
                  },
                  () =>
                      countMatchingTokens({
                          joinClauses: baseJoinClauses,
                          joinValues: baseJoinValues,
                          whereClauses: [
                              ...baseWhereClauses,
                              `${TOKEN_SORT_KEY_SQL} <= (?, ?, ?, ?)`,
                          ],
                          whereValues: [
                              ...baseWhereValues,
                              ...tokenSortKeyParams(cursorSortKey),
                          ],
                      }),
              )
            : 0;
        const rangeStart = items.length === 0 ? 0 : beforeItems + 1;
        const rangeEnd = beforeItems + items.length;
        const totalPages =
            totalItems === 0 ? 0 : Math.ceil(totalItems / params.limit);
        const currentPage =
            totalItems === 0 ? 0 : Math.floor(beforeItems / params.limit) + 1;

        const nextCursor = hasNext
            ? encodeOpaqueCursor({
                  kind: "all",
                  tokenId: pageRows[pageRows.length - 1]!.token_id,
              })
            : null;

        return {
            items,
            prevCursor,
            nextCursor,
            limit: params.limit,
            totalItems,
            rangeStart,
            rangeEnd,
            currentPage,
            totalPages,
        };
    }

    private listListedCollectionTokens(params: {
        chainId: number;
        collectionId: number;
        limit: number;
        nowSeconds: number;
        cursor: Extract<TokenCursor, { kind: "listed" }> | null;
        traitFilterGroups: TraitFilterGroup[];
        traitRangeFilterGroups: TraitRangeFilterGroup[];
        owner?: string;
    }): TokenCursorPage {
        const spanAttributes = buildTokenQuerySpanAttributes({
            chainId: params.chainId,
            collectionId: params.collectionId,
            tokenStatus: "listed",
            limit: params.limit,
            cursorPresent: Boolean(params.cursor),
            traitFilterGroups: params.traitFilterGroups,
            traitRangeFilterGroups: params.traitRangeFilterGroups,
            owner: params.owner,
        });
        const {
            baseJoinClauses,
            baseJoinValues,
            baseWhereClauses,
            baseWhereValues,
        } = buildTokenQueryParts({
            chainId: params.chainId,
            collectionId: params.collectionId,
            traitFilterGroups: params.traitFilterGroups,
            traitRangeFilterGroups: params.traitRangeFilterGroups,
            owner: params.owner,
        });
        const listingValues = buildCheapestListingValues({
            chainId: params.chainId,
            collectionId: params.collectionId,
            supportedCurrencies: this.supportedListingCurrencies,
            nowSeconds: params.nowSeconds,
        });
        const cursorKey = params.cursor
            ? toListingCursorKey(
                  params.cursor.listingPrice,
                  params.cursor.tokenId,
              )
            : null;
        const whereClauses = [...baseWhereClauses];
        const values: unknown[] = [
            ...baseJoinValues,
            ...listingValues,
            ...baseWhereValues,
        ];

        if (cursorKey) {
            whereClauses.push(
                `${LISTED_TOKEN_SORT_KEY_SQL} > (?, ?, ?, ?, ?, ?)`,
            );
            values.push(...listingCursorKeyParams(cursorKey));
        }

        const sql =
            "SELECT t.token_id, m.name, m.image, l.price AS listing_price, l.currency AS listing_currency, m.attributes_json, m.updated_at AS metadata_updated_at " +
            "FROM tokens t " +
            `${baseJoinClauses.join(" ")} ` +
            `JOIN (${buildCheapestListingSql(this.supportedListingCurrencies.length)}) l ` +
            "ON l.collection_id = t.collection_id " +
            "AND l.token_id = t.token_id " +
            "LEFT JOIN token_metadata m ON m.chain_id = t.chain_id " +
            "AND m.collection_id = t.collection_id " +
            "AND m.token_id = t.token_id " +
            `WHERE ${whereClauses.join(" AND ")} ` +
            `ORDER BY ${LISTED_ORDER_BY_ASC_SQL} ` +
            "LIMIT ?";

        const rows = this.apm.withSyncSpan(
            "backend.collection.db.tokens_page",
            spanAttributes,
            () =>
                db.raw
                    .prepare(sql)
                    .all(...values, params.limit + 1) as TokenRow[],
        );
        const hasNext = rows.length > params.limit;
        const pageRows = hasNext ? rows.slice(0, params.limit) : rows;
        const items = pageRows.map(mapTokenRow);

        const prevCursor = params.cursor
            ? this.apm.withSyncSpan(
                  "backend.collection.db.tokens_prev_cursor",
                  spanAttributes,
                  () =>
                      deriveListedPrevCursor({
                          listingSql: buildCheapestListingSql(
                              this.supportedListingCurrencies.length,
                          ),
                          baseJoinClauses,
                          baseJoinValues,
                          listingValues,
                          baseWhereClauses,
                          baseWhereValues,
                          cursor: params.cursor,
                          pageRows,
                          limit: params.limit,
                      }),
              )
            : null;

        const totalItems = this.apm.withSyncSpan(
            "backend.collection.db.tokens_count",
            {
                ...spanAttributes,
                "artgod.collection.count_kind": "total",
            },
            () =>
                countMatchingListedTokens({
                    joinClauses: baseJoinClauses,
                    joinValues: baseJoinValues,
                    listingSql: buildCheapestListingSql(
                        this.supportedListingCurrencies.length,
                    ),
                    listingValues,
                    whereClauses: baseWhereClauses,
                    whereValues: baseWhereValues,
                }),
        );
        const beforeItems = cursorKey
            ? this.apm.withSyncSpan(
                  "backend.collection.db.tokens_count",
                  {
                      ...spanAttributes,
                      "artgod.collection.count_kind": "before_cursor",
                  },
                  () =>
                      countMatchingListedTokens({
                          joinClauses: baseJoinClauses,
                          joinValues: baseJoinValues,
                          listingSql: buildCheapestListingSql(
                              this.supportedListingCurrencies.length,
                          ),
                          listingValues,
                          whereClauses: [
                              ...baseWhereClauses,
                              `${LISTED_TOKEN_SORT_KEY_SQL} <= (?, ?, ?, ?, ?, ?)`,
                          ],
                          whereValues: [
                              ...baseWhereValues,
                              ...listingCursorKeyParams(cursorKey),
                          ],
                      }),
              )
            : 0;
        const rangeStart = items.length === 0 ? 0 : beforeItems + 1;
        const rangeEnd = beforeItems + items.length;
        const totalPages =
            totalItems === 0 ? 0 : Math.ceil(totalItems / params.limit);
        const currentPage =
            totalItems === 0 ? 0 : Math.floor(beforeItems / params.limit) + 1;

        const nextCursor = hasNext
            ? encodeOpaqueCursor({
                  kind: "listed",
                  tokenId: pageRows[pageRows.length - 1]!.token_id,
                  listingPrice: pageRows[pageRows.length - 1]!.listing_price!,
              })
            : null;

        return {
            items,
            prevCursor,
            nextCursor,
            limit: params.limit,
            totalItems,
            rangeStart,
            rangeEnd,
            currentPage,
            totalPages,
        };
    }

    private listListedThenUnlistedCollectionTokens(params: {
        chainId: number;
        collectionId: number;
        limit: number;
        nowSeconds: number;
        cursor: Extract<TokenCursor, { kind: "listed_then_unlisted" }> | null;
        traitFilterGroups: TraitFilterGroup[];
        traitRangeFilterGroups: TraitRangeFilterGroup[];
        owner?: string;
    }): TokenCursorPage {
        const spanAttributes = buildTokenQuerySpanAttributes({
            chainId: params.chainId,
            collectionId: params.collectionId,
            tokenStatus: "listed_then_unlisted",
            limit: params.limit,
            cursorPresent: Boolean(params.cursor),
            traitFilterGroups: params.traitFilterGroups,
            traitRangeFilterGroups: params.traitRangeFilterGroups,
            owner: params.owner,
        });
        const {
            baseJoinClauses,
            baseJoinValues,
            baseWhereClauses,
            baseWhereValues,
        } = buildTokenQueryParts({
            chainId: params.chainId,
            collectionId: params.collectionId,
            traitFilterGroups: params.traitFilterGroups,
            traitRangeFilterGroups: params.traitRangeFilterGroups,
            owner: params.owner,
        });
        const listingSql = buildCheapestListingSql(
            this.supportedListingCurrencies.length,
        );
        const listingValues = buildCheapestListingValues({
            chainId: params.chainId,
            collectionId: params.collectionId,
            supportedCurrencies: this.supportedListingCurrencies,
            nowSeconds: params.nowSeconds,
        });
        const cursorKey = params.cursor
            ? toListedThenUnlistedCursorKey(
                  params.cursor.listingPrice,
                  params.cursor.tokenId,
              )
            : null;
        const whereClauses = [...baseWhereClauses];
        const values: unknown[] = [
            ...baseJoinValues,
            ...listingValues,
            ...baseWhereValues,
        ];

        if (cursorKey) {
            whereClauses.push(
                `${LISTED_THEN_UNLISTED_TOKEN_SORT_KEY_SQL} > (?, ?, ?, ?, ?, ?, ?)`,
            );
            values.push(...listedThenUnlistedCursorKeyParams(cursorKey));
        }

        const sql =
            "SELECT t.token_id, m.name, m.image, l.price AS listing_price, l.currency AS listing_currency, m.attributes_json, m.updated_at AS metadata_updated_at " +
            "FROM tokens t " +
            `${baseJoinClauses.join(" ")} ` +
            `LEFT JOIN (${listingSql}) l ` +
            "ON l.collection_id = t.collection_id " +
            "AND l.token_id = t.token_id " +
            "LEFT JOIN token_metadata m ON m.chain_id = t.chain_id " +
            "AND m.collection_id = t.collection_id " +
            "AND m.token_id = t.token_id " +
            `WHERE ${whereClauses.join(" AND ")} ` +
            `ORDER BY ${LISTED_THEN_UNLISTED_ORDER_BY_ASC_SQL} ` +
            "LIMIT ?";

        const rows = this.apm.withSyncSpan(
            "backend.collection.db.tokens_page",
            spanAttributes,
            () =>
                db.raw
                    .prepare(sql)
                    .all(...values, params.limit + 1) as TokenRow[],
        );
        const hasNext = rows.length > params.limit;
        const pageRows = hasNext ? rows.slice(0, params.limit) : rows;
        const items = pageRows.map(mapTokenRow);

        const prevCursor = params.cursor
            ? this.apm.withSyncSpan(
                  "backend.collection.db.tokens_prev_cursor",
                  spanAttributes,
                  () =>
                      deriveListedThenUnlistedPrevCursor({
                          listingSql,
                          listingValues,
                          baseJoinClauses,
                          baseJoinValues,
                          baseWhereClauses,
                          baseWhereValues,
                          cursor: params.cursor,
                          pageRows,
                          limit: params.limit,
                      }),
              )
            : null;

        const totalItems = this.apm.withSyncSpan(
            "backend.collection.db.tokens_count",
            {
                ...spanAttributes,
                "artgod.collection.count_kind": "total",
            },
            () =>
                countMatchingTokens({
                    joinClauses: baseJoinClauses,
                    joinValues: baseJoinValues,
                    whereClauses: baseWhereClauses,
                    whereValues: baseWhereValues,
                }),
        );
        const beforeItems = cursorKey
            ? this.apm.withSyncSpan(
                  "backend.collection.db.tokens_count",
                  {
                      ...spanAttributes,
                      "artgod.collection.count_kind": "before_cursor",
                  },
                  () =>
                      countMatchingMixedTokens({
                          joinClauses: baseJoinClauses,
                          joinValues: baseJoinValues,
                          listingSql,
                          listingValues,
                          whereClauses: [
                              ...baseWhereClauses,
                              `${LISTED_THEN_UNLISTED_TOKEN_SORT_KEY_SQL} <= (?, ?, ?, ?, ?, ?, ?)`,
                          ],
                          whereValues: [
                              ...baseWhereValues,
                              ...listedThenUnlistedCursorKeyParams(cursorKey),
                          ],
                      }),
              )
            : 0;
        const rangeStart = items.length === 0 ? 0 : beforeItems + 1;
        const rangeEnd = beforeItems + items.length;
        const totalPages =
            totalItems === 0 ? 0 : Math.ceil(totalItems / params.limit);
        const currentPage =
            totalItems === 0 ? 0 : Math.floor(beforeItems / params.limit) + 1;

        const nextCursor = hasNext
            ? encodeOpaqueCursor({
                  kind: "listed_then_unlisted",
                  tokenId: pageRows[pageRows.length - 1]!.token_id,
                  listingPrice:
                      pageRows[pageRows.length - 1]!.listing_price ?? null,
              })
            : null;

        return {
            items,
            prevCursor,
            nextCursor,
            limit: params.limit,
            totalItems,
            rangeStart,
            rangeEnd,
            currentPage,
            totalPages,
        };
    }

    listCollectionTraitFacets(
        chainId: number,
        collectionId: number,
        owner?: string,
        options: ListCollectionTraitFacetsOptions = {},
    ): TraitFacet[] {
        const excludeKeys = normalizeTraitKeyList(options.excludeKeys);
        const rows = this.apm.withSyncSpan(
            "backend.collection.db.trait_facets",
            {
                "artgod.chain_id": chainId,
                "artgod.collection_id": collectionId,
                "artgod.collection.owner_present": Boolean(owner),
                "artgod.collection.exclude_keys_count": excludeKeys.length,
            },
            () =>
                owner
                    ? this.selectOwnerScopedTraitFacetRowsWithOptions(
                          chainId,
                          collectionId,
                          normalizeAddressRef(owner),
                          excludeKeys,
                      )
                    : this.selectTraitFacetRowsWithOptions(
                          chainId,
                          collectionId,
                          excludeKeys,
                      ),
        );

        const facets: TraitFacet[] = [];
        const byKey = new Map<string, TraitFacet>();
        for (const row of rows) {
            let facet = byKey.get(row.key);
            if (!facet) {
                facet = {
                    key: row.key,
                    displayKind: TRAIT_FILTER_DISPLAY_KIND.Set,
                    minValue: null,
                    maxValue: null,
                    values: [],
                };
                byKey.set(row.key, facet);
                facets.push(facet);
            }
            facet.values.push({
                value: row.value,
                tokenCount: row.token_count,
            });
        }
        return facets;
    }

    private selectTraitFacetRowsWithOptions(
        chainId: number,
        collectionId: number,
        excludeKeys: string[],
    ): TraitFacetRow[] {
        if (excludeKeys.length === 0) {
            return this.selectTraitFacetRows.all(
                chainId,
                collectionId,
            ) as TraitFacetRow[];
        }

        const placeholders = excludeKeys.map(() => "?").join(", ");
        return db.raw
            .prepare(
                "SELECT attribute_keys.key as key, attributes.value as value, collection_trait_stats.token_count as token_count " +
                    "FROM collection_trait_stats " +
                    "JOIN attributes ON attributes.id = collection_trait_stats.attribute_id " +
                    "AND attributes.chain_id = collection_trait_stats.chain_id " +
                    "AND attributes.collection_id = collection_trait_stats.collection_id " +
                    "JOIN attribute_keys ON attribute_keys.id = collection_trait_stats.attribute_key_id " +
                    "AND attribute_keys.chain_id = collection_trait_stats.chain_id " +
                    "AND attribute_keys.collection_id = collection_trait_stats.collection_id " +
                    "WHERE collection_trait_stats.chain_id = ? AND collection_trait_stats.collection_id = ? " +
                    `AND attribute_keys.key NOT IN (${placeholders}) ` +
                    "ORDER BY attribute_keys.key ASC, collection_trait_stats.token_count ASC, attributes.value ASC",
            )
            .all(chainId, collectionId, ...excludeKeys) as TraitFacetRow[];
    }

    private selectOwnerScopedTraitFacetRowsWithOptions(
        chainId: number,
        collectionId: number,
        owner: string,
        excludeKeys: string[],
    ): TraitFacetRow[] {
        if (excludeKeys.length === 0) {
            return this.selectOwnerScopedTraitFacetRows.all(
                chainId,
                collectionId,
                owner,
            ) as TraitFacetRow[];
        }

        const placeholders = excludeKeys.map(() => "?").join(", ");
        return db.raw
            .prepare(
                "SELECT ak.key AS key, a.value AS value, COUNT(*) AS token_count " +
                    "FROM token_attributes ta " +
                    "JOIN attributes a ON a.id = ta.attribute_id " +
                    "AND a.chain_id = ta.chain_id " +
                    "AND a.collection_id = ta.collection_id " +
                    "JOIN attribute_keys ak ON ak.id = a.attribute_key_id " +
                    "AND ak.chain_id = a.chain_id " +
                    "AND ak.collection_id = a.collection_id " +
                    "WHERE ta.chain_id = ? " +
                    "AND ta.collection_id = ? " +
                    `AND ak.key NOT IN (${placeholders}) ` +
                    "AND EXISTS ( " +
                    "SELECT 1 FROM nft_balances b " +
                    "WHERE b.chain_id = ta.chain_id " +
                    "AND b.collection_id = ta.collection_id " +
                    "AND b.token_id = ta.token_id " +
                    "AND lower(b.owner) = ? " +
                    "AND CAST(b.amount AS INTEGER) > 0" +
                    ") " +
                    "GROUP BY ak.key, a.value " +
                    "ORDER BY ak.key ASC, token_count ASC, a.value ASC",
            )
            .all(
                chainId,
                collectionId,
                ...excludeKeys,
                owner,
            ) as TraitFacetRow[];
    }

    getCollectionTokenDetail(
        params: GetCollectionTokenDetailParams,
    ): TokenDetail {
        const tokenId = normalizeCollectionTokenId(params.tokenId);

        const row = this.selectTokenDetailRow({
            chainId: params.chainId,
            collectionId: params.collectionId,
            tokenId,
        });
        if (!row) {
            throw new ReadModelNotFoundError("Unknown token_ref");
        }

        const totalItems = countCollectionTokens(
            params.chainId,
            params.collectionId,
        );
        const attributeRows = this.selectTokenDetailTraitRows.all(
            params.chainId,
            params.collectionId,
            tokenId,
        ) as TokenDetailTraitRow[];
        const attributes = mergeTokenDetailTraits({
            normalizedTraits: attributeRows.map((item) =>
                mapTokenDetailTraitRow(item, totalItems),
            ),
            metadataTraits: parseTokenAttributes(row.attributes_json),
        });

        return {
            tokenId: row.token_id,
            name: row.name ?? null,
            image: row.image ?? null,
            animationUrl: row.animation_url ?? null,
            listingPrice: row.listing_price ?? null,
            listingCurrency: row.listing_currency ?? null,
            currentHolder:
                (
                    this.selectTokenCurrentHolderRow.get(
                        params.chainId,
                        params.collectionId,
                        tokenId,
                    ) as TokenCurrentHolderRow | undefined
                )?.owner ?? null,
            attributes,
            hasMetadata: row.metadata_updated_at !== null,
            metadataUpdatedAt: row.metadata_updated_at ?? null,
        };
    }

    getCollectionTokenPreview(
        params: GetCollectionTokenDetailParams,
    ): TokenMediaPreview {
        const tokenId = normalizeCollectionTokenId(params.tokenId);
        const row = this.selectTokenPreviewRow.get({
            chainId: params.chainId,
            collectionId: params.collectionId,
            tokenId,
        }) as TokenPreviewRow | undefined;
        if (!row) {
            throw new ReadModelNotFoundError("Unknown token_ref");
        }

        return {
            tokenId: row.token_id,
            image: row.image ?? null,
            animationUrl: row.animation_url ?? null,
        };
    }

    private selectTokenDetailRow(params: {
        chainId: number;
        collectionId: number;
        tokenId: string;
    }): TokenDetailRow | undefined {
        const listingSql = buildCheapestListingSql(
            this.supportedListingCurrencies.length,
        );
        const listingValues = buildCheapestListingValues({
            chainId: params.chainId,
            collectionId: params.collectionId,
            supportedCurrencies: this.supportedListingCurrencies,
            nowSeconds: Math.floor(Date.now() / 1000),
        });

        return db.raw
            .prepare(
                "SELECT t.token_id, m.name, m.image, m.animation_url, l.price AS listing_price, l.currency AS listing_currency, m.attributes_json, m.updated_at AS metadata_updated_at " +
                    "FROM tokens t " +
                    "LEFT JOIN token_metadata m ON m.chain_id = t.chain_id " +
                    "AND m.collection_id = t.collection_id " +
                    "AND m.token_id = t.token_id " +
                    `LEFT JOIN (${listingSql}) l ` +
                    "ON l.collection_id = t.collection_id " +
                    "AND l.token_id = t.token_id " +
                    "WHERE t.chain_id = ? AND t.collection_id = ? AND t.token_id = ? " +
                    "LIMIT 1",
            )
            .get(
                ...listingValues,
                params.chainId,
                params.collectionId,
                params.tokenId,
            ) as TokenDetailRow | undefined;
    }

    listCollectionTokenCardsByIds(
        params: ListCollectionTokenCardsByIdsParams,
    ): TokenCard[] {
        const tokenIds = normalizeTokenIds(params.tokenIds);
        if (tokenIds.length === 0) {
            return [];
        }

        const includeListings = params.includeListings === true;
        const listingSql = includeListings
            ? buildCheapestListingSql(this.supportedListingCurrencies.length)
            : null;
        const listingValues = includeListings
            ? buildCheapestListingValues({
                  chainId: params.chainId,
                  collectionId: params.collectionId,
                  supportedCurrencies: this.supportedListingCurrencies,
                  nowSeconds: Math.floor(Date.now() / 1000),
              })
            : [];
        const placeholders = tokenIds.map(() => "?").join(", ");
        const rows = db.raw
            .prepare(
                "SELECT t.token_id, m.name, m.image, " +
                    (includeListings
                        ? "l.price AS listing_price, l.currency AS listing_currency, "
                        : "NULL AS listing_price, NULL AS listing_currency, ") +
                    "m.attributes_json, m.updated_at AS metadata_updated_at " +
                    "FROM tokens t " +
                    (includeListings
                        ? `LEFT JOIN (${listingSql}) l ON l.collection_id = t.collection_id AND l.token_id = t.token_id `
                        : "") +
                    "LEFT JOIN token_metadata m ON m.chain_id = t.chain_id " +
                    "AND m.collection_id = t.collection_id " +
                    "AND m.token_id = t.token_id " +
                    "WHERE t.chain_id = ? AND t.collection_id = ? " +
                    `AND t.token_id IN (${placeholders})`,
            )
            .all(
                ...listingValues,
                params.chainId,
                params.collectionId,
                ...tokenIds,
            ) as TokenRow[];

        const byId = new Map(
            rows.map((row) => [row.token_id, mapTokenRow(row)]),
        );

        return tokenIds.flatMap((tokenId) => {
            const token = byId.get(tokenId);
            return token ? [token] : [];
        });
    }

    listCollectionHolders(
        params: ListCollectionHoldersParams,
    ): CollectionHolderPage {
        const limit = normalizeLimit(params.limit);
        const cursor =
            params.cursor !== undefined
                ? decodeHolderCursor(params.cursor)
                : null;
        const values: unknown[] = [params.chainId, params.collectionId];

        if (cursor) {
            values.push(
                cursor.count.length,
                cursor.count.length,
                cursor.count.value,
                cursor.count.length,
                cursor.count.value,
                cursor.owner,
            );
        }

        const rows = db.raw
            .prepare(buildCollectionHoldersPageSql(cursor !== null))
            .all(...values, limit + 1) as HolderRow[];
        const rowsWithData = rows.filter(
            (row) =>
                row.owner !== null &&
                row.token_count !== null &&
                row.row_num !== null,
        );
        const hasNext = rowsWithData.length > limit;
        const pageRows = hasNext ? rowsWithData.slice(0, limit) : rowsWithData;
        const items = pageRows.map(mapHolderRow);
        const totalItems = rows[0]?.total_count ?? 0;
        const rangeStart = pageRows[0]?.row_num ?? 0;
        const rangeEnd = pageRows[pageRows.length - 1]?.row_num ?? 0;
        const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / limit);
        const currentPage =
            rangeStart === 0 ? 0 : Math.floor((rangeStart - 1) / limit) + 1;
        const nextCursor = hasNext
            ? encodeOpaqueCursor({
                  tokenCount: pageRows[pageRows.length - 1]!.token_count!,
                  owner: pageRows[pageRows.length - 1]!.owner!,
              })
            : null;

        return {
            items,
            nextCursor,
            limit,
            totalItems,
            rangeStart,
            rangeEnd,
            currentPage,
            totalPages,
        };
    }
}

function countMatchingTokens(params: {
    joinClauses: string[];
    joinValues: unknown[];
    whereClauses: string[];
    whereValues: unknown[];
}): number {
    const sql =
        "SELECT COUNT(*) AS count " +
        "FROM tokens t " +
        `${params.joinClauses.join(" ")} ` +
        `WHERE ${params.whereClauses.join(" AND ")}`;
    const row = db.raw
        .prepare(sql)
        .get(...params.joinValues, ...params.whereValues) as { count: number };
    return row.count;
}

function countMatchingListedTokens(params: {
    joinClauses: string[];
    joinValues: unknown[];
    listingSql: string;
    listingValues: unknown[];
    whereClauses: string[];
    whereValues: unknown[];
}): number {
    const sql =
        "SELECT COUNT(*) AS count " +
        "FROM tokens t " +
        `${params.joinClauses.join(" ")} ` +
        `JOIN (${params.listingSql}) l ` +
        "ON l.collection_id = t.collection_id " +
        "AND l.token_id = t.token_id " +
        `WHERE ${params.whereClauses.join(" AND ")}`;
    const row = db.raw
        .prepare(sql)
        .get(
            ...params.joinValues,
            ...params.listingValues,
            ...params.whereValues,
        ) as { count: number };
    return row.count;
}

function countMatchingMixedTokens(params: {
    joinClauses: string[];
    joinValues: unknown[];
    listingSql: string;
    listingValues: unknown[];
    whereClauses: string[];
    whereValues: unknown[];
}): number {
    const sql =
        "SELECT COUNT(*) AS count " +
        "FROM tokens t " +
        `${params.joinClauses.join(" ")} ` +
        `LEFT JOIN (${params.listingSql}) l ` +
        "ON l.collection_id = t.collection_id " +
        "AND l.token_id = t.token_id " +
        `WHERE ${params.whereClauses.join(" AND ")}`;
    const row = db.raw
        .prepare(sql)
        .get(
            ...params.joinValues,
            ...params.listingValues,
            ...params.whereValues,
        ) as { count: number };
    return row.count;
}

function countCollectionTokens(chainId: number, collectionId: number): number {
    const row = db.raw
        .prepare(
            "SELECT COUNT(*) AS count FROM tokens WHERE chain_id = ? AND collection_id = ?",
        )
        .get(chainId, collectionId) as { count: number };
    return row.count;
}

function derivePrevCursor(params: {
    baseJoinClauses: string[];
    baseJoinValues: unknown[];
    baseWhereClauses: string[];
    baseWhereValues: unknown[];
    cursor: Extract<TokenCursor, { kind: "all" }> | null;
    pageRows: TokenRow[];
    limit: number;
}): string | null {
    const {
        baseJoinClauses,
        baseJoinValues,
        baseWhereClauses,
        baseWhereValues,
        cursor,
        pageRows,
        limit,
    } = params;

    const anchorTokenId = pageRows[0]?.token_id ?? cursor?.tokenId ?? null;
    if (!anchorTokenId) {
        return null;
    }
    const anchorSortKey = toTokenSortKey(anchorTokenId);

    const previousRows = db.raw
        .prepare(
            "SELECT t.token_id " +
                "FROM tokens t " +
                `${baseJoinClauses.join(" ")} ` +
                `WHERE ${baseWhereClauses.join(" AND ")} AND ${TOKEN_SORT_KEY_SQL} < (?, ?, ?, ?) ` +
                `ORDER BY ${TOKEN_ORDER_BY_DESC_SQL} ` +
                "LIMIT ?",
        )
        .all(
            ...baseJoinValues,
            ...baseWhereValues,
            ...tokenSortKeyParams(anchorSortKey),
            limit + 1,
        ) as TokenIdRow[];

    if (previousRows.length <= limit) {
        return null;
    }

    return encodeOpaqueCursor({
        kind: "all",
        tokenId: previousRows[limit]!.token_id,
    });
}

function deriveListedPrevCursor(params: {
    listingSql: string;
    listingValues: unknown[];
    baseJoinClauses: string[];
    baseJoinValues: unknown[];
    baseWhereClauses: string[];
    baseWhereValues: unknown[];
    cursor: Extract<TokenCursor, { kind: "listed" }> | null;
    pageRows: TokenRow[];
    limit: number;
}): string | null {
    const {
        listingSql,
        listingValues,
        baseJoinClauses,
        baseJoinValues,
        baseWhereClauses,
        baseWhereValues,
        cursor,
        pageRows,
        limit,
    } = params;

    const anchorTokenId = pageRows[0]?.token_id ?? cursor?.tokenId ?? null;
    const anchorListingPrice =
        pageRows[0]?.listing_price ?? cursor?.listingPrice ?? null;
    if (!anchorTokenId || !anchorListingPrice) {
        return null;
    }
    const anchorKey = toListingCursorKey(anchorListingPrice, anchorTokenId);

    const previousRows = db.raw
        .prepare(
            "SELECT t.token_id, l.price AS listing_price " +
                "FROM tokens t " +
                `${baseJoinClauses.join(" ")} ` +
                `JOIN (${listingSql}) l ` +
                "ON l.collection_id = t.collection_id " +
                "AND l.token_id = t.token_id " +
                `WHERE ${baseWhereClauses.join(" AND ")} AND ${LISTED_TOKEN_SORT_KEY_SQL} < (?, ?, ?, ?, ?, ?) ` +
                `ORDER BY ${LISTED_ORDER_BY_DESC_SQL} ` +
                "LIMIT ?",
        )
        .all(
            ...baseJoinValues,
            ...listingValues,
            ...baseWhereValues,
            ...listingCursorKeyParams(anchorKey),
            limit + 1,
        ) as Array<{
        token_id: string;
        listing_price: string;
    }>;

    if (previousRows.length <= limit) {
        return null;
    }

    return encodeOpaqueCursor({
        kind: "listed",
        tokenId: previousRows[limit]!.token_id,
        listingPrice: previousRows[limit]!.listing_price,
    });
}

function deriveListedThenUnlistedPrevCursor(params: {
    listingSql: string;
    listingValues: unknown[];
    baseJoinClauses: string[];
    baseJoinValues: unknown[];
    baseWhereClauses: string[];
    baseWhereValues: unknown[];
    cursor: Extract<TokenCursor, { kind: "listed_then_unlisted" }> | null;
    pageRows: TokenRow[];
    limit: number;
}): string | null {
    const {
        listingSql,
        listingValues,
        baseJoinClauses,
        baseJoinValues,
        baseWhereClauses,
        baseWhereValues,
        cursor,
        pageRows,
        limit,
    } = params;

    const anchorTokenId =
        pageRows.length > 0 ? pageRows[0]!.token_id : (cursor?.tokenId ?? null);
    if (!anchorTokenId) {
        return null;
    }

    const anchorKey = toListedThenUnlistedCursorKey(
        pageRows.length > 0
            ? (pageRows[0]!.listing_price ?? null)
            : (cursor?.listingPrice ?? null),
        anchorTokenId,
    );

    const previousRows = db.raw
        .prepare(
            "SELECT t.token_id, l.price AS listing_price " +
                "FROM tokens t " +
                `${baseJoinClauses.join(" ")} ` +
                `LEFT JOIN (${listingSql}) l ` +
                "ON l.collection_id = t.collection_id " +
                "AND l.token_id = t.token_id " +
                `WHERE ${baseWhereClauses.join(" AND ")} AND ${LISTED_THEN_UNLISTED_TOKEN_SORT_KEY_SQL} < (?, ?, ?, ?, ?, ?, ?) ` +
                `ORDER BY ${LISTED_THEN_UNLISTED_ORDER_BY_DESC_SQL} ` +
                "LIMIT ?",
        )
        .all(
            ...baseJoinValues,
            ...listingValues,
            ...baseWhereValues,
            ...listedThenUnlistedCursorKeyParams(anchorKey),
            limit + 1,
        ) as TokenListingRow[];

    if (previousRows.length <= limit) {
        return null;
    }

    return encodeOpaqueCursor({
        kind: "listed_then_unlisted",
        tokenId: previousRows[limit]!.token_id,
        listingPrice: previousRows[limit]!.listing_price ?? null,
    });
}

function normalizeLimit(limit: number): number {
    if (!Number.isInteger(limit) || limit <= 0) {
        throw new ReadModelBadRequestError("Invalid limit");
    }
    return Math.min(limit, MAX_PAGE_LIMIT);
}

function decodeCollectionCursor(cursor: string): CollectionListCursor {
    try {
        const decoded = decodeOpaqueCursor<CollectionListCursor>(cursor);
        if (
            !decoded ||
            typeof decoded.createdAt !== "string" ||
            typeof decoded.slug !== "string"
        ) {
            throw new Error("bad payload");
        }
        return {
            createdAt: decoded.createdAt,
            slug: decoded.slug,
        };
    } catch {
        throw new ReadModelBadRequestError("Invalid cursor");
    }
}

function decodeTokenCursor(cursor: string): TokenCursor {
    try {
        const decoded = decodeOpaqueCursor<TokenCursor>(cursor);
        if (!decoded || typeof decoded !== "object") {
            throw new Error("bad payload");
        }
        if (
            "kind" in decoded &&
            decoded.kind === "listed" &&
            typeof decoded.tokenId === "string" &&
            typeof decoded.listingPrice === "string"
        ) {
            return decoded;
        }
        if (
            "kind" in decoded &&
            decoded.kind === "listed_then_unlisted" &&
            typeof decoded.tokenId === "string" &&
            (decoded.listingPrice === null ||
                typeof decoded.listingPrice === "string")
        ) {
            return decoded;
        }
        if (
            ("kind" in decoded ? decoded.kind === "all" : true) &&
            typeof decoded.tokenId === "string"
        ) {
            return {
                kind: "all",
                tokenId: decoded.tokenId,
            };
        }
        throw new Error("bad payload");
    } catch {
        throw new ReadModelBadRequestError("Invalid cursor");
    }
}

function decodeHolderCursor(cursor: string): HolderCursorKey {
    try {
        const decoded = decodeOpaqueCursor<HolderCursor>(cursor);
        if (
            !decoded ||
            typeof decoded.tokenCount !== "string" ||
            typeof decoded.owner !== "string"
        ) {
            throw new Error("bad payload");
        }
        return {
            count: toHolderCountSortKey(decoded.tokenCount),
            owner: decoded.owner.toLowerCase(),
        };
    } catch {
        throw new ReadModelBadRequestError("Invalid cursor");
    }
}

function toTokenSortKey(tokenId: string): TokenSortKey {
    const isNumeric = /^\d+$/.test(tokenId);
    if (!isNumeric) {
        return {
            tokenId,
            bucket: 1,
            length: 0,
            value: tokenId,
        };
    }

    const withoutLeadingZeros = tokenId.replace(/^0+/, "");
    const normalized =
        withoutLeadingZeros.length > 0 ? withoutLeadingZeros : "0";
    return {
        tokenId,
        bucket: 0,
        length: normalized.length,
        value: normalized,
    };
}

function tokenSortKeyParams(
    key: TokenSortKey,
): [number, number, string, string] {
    return [key.bucket, key.length, key.value, key.tokenId];
}

function buildCollectionHoldersSql(): string {
    return `
        WITH holder_totals AS (
            SELECT
                lower(owner) AS owner,
                SUM(CAST(amount AS INTEGER)) AS token_count_int
            FROM nft_balances
            WHERE chain_id = ? AND collection_id = ?
            GROUP BY lower(owner)
            HAVING SUM(CAST(amount AS INTEGER)) > 0
        ),
        holder_sort_keys AS (
            SELECT
                owner,
                CAST(token_count_int AS TEXT) AS token_count,
                CASE
                    WHEN SUM(token_count_int) OVER () <= 0 THEN NULL
                    ELSE (CAST(token_count_int AS REAL) * 100.0) /
                        SUM(token_count_int) OVER ()
                END AS held_percent,
                CASE
                    WHEN LTRIM(CAST(token_count_int AS TEXT), '0') = '' THEN '0'
                    ELSE LTRIM(CAST(token_count_int AS TEXT), '0')
                END AS count_sort_value
            FROM holder_totals
        )
        SELECT
            owner,
            token_count,
            held_percent,
            LENGTH(count_sort_value) AS count_sort_length,
            count_sort_value
        FROM holder_sort_keys
    `.trim();
}

function buildCollectionHoldersPageSql(hasCursor: boolean): string {
    const rangeStartSql = hasCursor
        ? `(SELECT MIN(h.row_num) FROM holder_ranked h WHERE ${buildHolderAfterCursorWhereClause()})`
        : "(SELECT MIN(h.row_num) FROM holder_ranked h)";

    return `
        WITH holder_ranked AS (
            SELECT
                h.owner,
                h.token_count,
                h.held_percent,
                h.count_sort_length,
                h.count_sort_value,
                ROW_NUMBER() OVER (
                    ORDER BY h.count_sort_length DESC, h.count_sort_value DESC, h.owner ASC
                ) AS row_num,
                COUNT(*) OVER () AS total_count
            FROM (${buildCollectionHoldersSql()}) h
        ),
        page_meta AS (
            SELECT
                COALESCE((SELECT MAX(total_count) FROM holder_ranked), 0) AS total_count,
                ${rangeStartSql} AS range_start
        ),
        page_rows AS (
            SELECT
                h.owner,
                h.token_count,
                h.held_percent,
                h.row_num
            FROM holder_ranked h
            CROSS JOIN page_meta pm
            WHERE pm.range_start IS NOT NULL
              AND h.row_num >= pm.range_start
            ORDER BY h.row_num ASC
            LIMIT ?
        )
        SELECT
            pr.owner,
            pr.token_count,
            pr.held_percent,
            pr.row_num,
            pm.total_count
        FROM page_meta pm
        LEFT JOIN page_rows pr ON 1 = 1
        ORDER BY pr.row_num ASC
    `.trim();
}

function buildHolderAfterCursorWhereClause(): string {
    return (
        "(h.count_sort_length < ? " +
        "OR (h.count_sort_length = ? AND h.count_sort_value < ?) " +
        "OR (h.count_sort_length = ? AND h.count_sort_value = ? AND h.owner > ?))"
    );
}

function mapHolderRow(row: HolderRow): CollectionHolder {
    return {
        owner: row.owner!.toLowerCase(),
        tokenCount: row.token_count!,
        heldPercent: row.held_percent,
    };
}

function toListingPriceSortKey(rawPrice: string): ListingPriceSortKey {
    if (!/^\d+$/.test(rawPrice)) {
        throw new ReadModelBadRequestError("Invalid cursor");
    }
    const normalized = rawPrice.replace(/^0+/, "") || "0";
    return {
        raw: rawPrice,
        length: normalized.length,
        value: normalized,
    };
}

function toHolderCountSortKey(rawCount: string): HolderCountSortKey {
    if (!/^\d+$/.test(rawCount)) {
        throw new ReadModelBadRequestError("Invalid cursor");
    }
    const normalized = rawCount.replace(/^0+/, "") || "0";
    return {
        raw: rawCount,
        length: normalized.length,
        value: normalized,
    };
}

function toListingCursorKey(
    rawPrice: string,
    tokenId: string,
): ListingCursorKey {
    return {
        price: toListingPriceSortKey(rawPrice),
        token: toTokenSortKey(tokenId),
    };
}

function listingCursorKeyParams(
    key: ListingCursorKey,
): [number, string, number, number, string, string] {
    return [
        key.price.length,
        key.price.value,
        ...tokenSortKeyParams(key.token),
    ];
}

function toListedThenUnlistedCursorKey(
    rawPrice: string | null,
    tokenId: string,
): ListedThenUnlistedCursorKey {
    const token = toTokenSortKey(tokenId);
    if (rawPrice === null) {
        return {
            block: 1,
            priceLength: 0,
            priceValue: "",
            token,
            tokenId,
            listingPrice: null,
        };
    }

    const price = toListingPriceSortKey(rawPrice);
    return {
        block: 0,
        priceLength: price.length,
        priceValue: price.value,
        token,
        tokenId,
        listingPrice: rawPrice,
    };
}

function listedThenUnlistedCursorKeyParams(
    key: ListedThenUnlistedCursorKey,
): [number, number, string, number, number, string, string] {
    return [
        key.block,
        key.priceLength,
        key.priceValue,
        ...tokenSortKeyParams(key.token),
    ];
}

function normalizeTokenIds(tokenIds: string[]): string[] {
    const normalized: string[] = [];
    const seen = new Set<string>();

    for (const rawTokenId of tokenIds) {
        const tokenId = rawTokenId.trim();
        if (!tokenId || seen.has(tokenId)) {
            continue;
        }
        seen.add(tokenId);
        normalized.push(tokenId);
    }

    return normalized;
}

function buildTokenQuerySpanAttributes(params: {
    chainId: number;
    collectionId: number;
    tokenStatus: TokenBrowserStatus;
    limit: number;
    cursorPresent: boolean;
    traitFilterGroups: TraitFilterGroup[];
    traitRangeFilterGroups: TraitRangeFilterGroup[];
    owner?: string;
}): SpanAttributes {
    return {
        "artgod.chain_id": params.chainId,
        "artgod.collection_id": params.collectionId,
        "artgod.collection.token_status": params.tokenStatus,
        "artgod.collection.limit": params.limit,
        "artgod.collection.cursor_present": params.cursorPresent,
        "artgod.collection.trait_filters_count":
            params.traitFilterGroups.length,
        "artgod.collection.trait_ranges_count":
            params.traitRangeFilterGroups.length,
        "artgod.collection.owner_present": Boolean(params.owner),
    };
}

function buildTokenQueryParts(params: {
    chainId: number;
    collectionId: number;
    traitFilterGroups: TraitFilterGroup[];
    traitRangeFilterGroups: TraitRangeFilterGroup[];
    owner?: string;
}): {
    baseJoinClauses: string[];
    baseJoinValues: unknown[];
    baseWhereClauses: string[];
    baseWhereValues: unknown[];
} {
    const baseJoinClauses: string[] = [];
    const baseJoinValues: unknown[] = [];
    const baseWhereClauses: string[] = [
        "t.chain_id = ?",
        "t.collection_id = ?",
    ];
    const baseWhereValues: unknown[] = [params.chainId, params.collectionId];

    if (params.owner) {
        baseWhereClauses.push(
            "EXISTS (" +
                "SELECT 1 FROM nft_balances b " +
                "WHERE b.chain_id = t.chain_id " +
                "AND b.collection_id = t.collection_id " +
                "AND b.token_id = t.token_id " +
                "AND lower(b.owner) = ? " +
                "AND CAST(b.amount AS INTEGER) > 0" +
                ")",
        );
        baseWhereValues.push(params.owner);
    }

    const { whereClauses: traitWhereClauses, values: traitValues } =
        buildTokenTraitFilterWhereClauses({
            traitFilterGroups: params.traitFilterGroups,
            chainColumnSql: "t.chain_id",
            collectionColumnSql: "t.collection_id",
            tokenColumnSql: "t.token_id",
        });
    baseWhereClauses.push(...traitWhereClauses);
    baseWhereValues.push(...traitValues);

    const { joinClauses: traitRangeJoinClauses, values: traitRangeValues } =
        buildTokenTraitRangeJoinClauses({
            traitRangeFilterGroups: params.traitRangeFilterGroups,
            tokenColumnSql: "t.token_id",
            chainId: params.chainId,
            collectionId: params.collectionId,
        });
    baseJoinClauses.push(...traitRangeJoinClauses);
    baseJoinValues.push(...traitRangeValues);

    return {
        baseJoinClauses,
        baseJoinValues,
        baseWhereClauses,
        baseWhereValues,
    };
}

export function applyTraitFilterPresentationToFacets(params: {
    facets: TraitFacet[];
    config: TraitFilterPresentationConfig;
}): TraitFacet[] {
    const rangeKeys = new Set(params.config.rangeKeys);

    return params.facets.map((facet) => {
        const isRange = rangeKeys.has(facet.key);
        const { minValue, maxValue } = isRange
            ? resolveNumericTraitBounds(facet.values)
            : { minValue: null, maxValue: null };

        return {
            ...facet,
            displayKind: isRange
                ? TRAIT_FILTER_DISPLAY_KIND.Range
                : TRAIT_FILTER_DISPLAY_KIND.Set,
            minValue,
            maxValue,
        };
    });
}

function resolveNumericTraitBounds(values: TraitFacet["values"]): {
    minValue: string | null;
    maxValue: string | null;
} {
    let minValue: bigint | null = null;
    let maxValue: bigint | null = null;

    for (const value of values) {
        if (!/^\d+$/.test(value.value)) {
            continue;
        }
        const numeric = BigInt(value.value);
        minValue = minValue === null || numeric < minValue ? numeric : minValue;
        maxValue = maxValue === null || numeric > maxValue ? numeric : maxValue;
    }

    return {
        minValue: minValue?.toString() ?? null,
        maxValue: maxValue?.toString() ?? null,
    };
}

function buildCheapestListingSql(supportedCurrencyCount: number): string {
    const currencyPlaceholders = new Array(supportedCurrencyCount)
        .fill("?")
        .join(", ");
    return (
        "SELECT ranked.collection_id, ranked.token_id, ranked.price, ranked.currency, ranked.price_sort_length, ranked.price_sort_value " +
        "FROM (" +
        "SELECT o.collection_id, o.token_id, o.price, o.currency, " +
        `${LISTING_PRICE_LENGTH_SQL} AS price_sort_length, ` +
        `${LISTING_PRICE_NORMALIZED_SQL} AS price_sort_value, ` +
        "ROW_NUMBER() OVER (" +
        "PARTITION BY o.collection_id, o.token_id " +
        `ORDER BY ${LISTING_PRICE_LENGTH_SQL} ASC, ${LISTING_PRICE_NORMALIZED_SQL} ASC, o.currency ASC, o.id ASC` +
        ") AS row_number " +
        "FROM orders o " +
        "WHERE o.chain_id = ? " +
        "AND o.collection_id = ? " +
        "AND o.source_scope_kind = 'token' " +
        "AND o.side = 'sell' " +
        "AND o.token_id IS NOT NULL " +
        "AND o.source_status = 'active' " +
        "AND o.fillability_status = 'fillable' " +
        `AND o.currency IN (${currencyPlaceholders}) ` +
        `AND ${LISTING_PRICE_IS_NUMERIC_SQL} ` +
        "AND (o.valid_from IS NULL OR o.valid_from <= ?) " +
        "AND (o.valid_until IS NULL OR o.valid_until >= ?) " +
        ") ranked " +
        "WHERE ranked.row_number = 1"
    );
}

function buildCheapestListingValues(params: {
    chainId: number;
    collectionId: number;
    supportedCurrencies: string[];
    nowSeconds: number;
}): unknown[] {
    return [
        params.chainId,
        params.collectionId,
        ...params.supportedCurrencies,
        params.nowSeconds,
        params.nowSeconds,
    ];
}

function mapCollectionRow(row: CollectionRow): CollectionListItem {
    return {
        chainId: row.chain_id,
        collectionId: row.collection_id,
        slug: row.slug,
        address: row.address.toLowerCase(),
        standard: row.standard as CollectionListItem["standard"],
        status: row.status as CollectionListItem["status"],
        deploymentBlock: row.deployment_block,
        bootstrapAnchorBlock: row.bootstrap_anchor_block,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function normalizeCollectionTokenId(tokenId: string): string {
    const normalized = tokenId.trim();
    if (!normalized) {
        throw new ReadModelBadRequestError("Invalid token_ref");
    }
    return normalized;
}

function mapTokenRow(row: TokenRow): TokenCard {
    return {
        tokenId: row.token_id,
        name: row.name ?? null,
        image: row.image ?? null,
        traitSummary: null,
        listingPrice: row.listing_price ?? null,
        listingCurrency: row.listing_currency ?? null,
        attributes: parseTokenAttributes(row.attributes_json),
        hasMetadata: row.metadata_updated_at !== null,
        metadataUpdatedAt: row.metadata_updated_at,
    };
}

function mapTokenDetailTraitRow(
    row: TokenDetailTraitRow,
    totalItems: number,
): TokenDetailTrait {
    const tokenCount = row.token_count ?? null;
    const rarityPercent =
        tokenCount === null || totalItems <= 0
            ? null
            : (tokenCount / totalItems) * 100;
    return {
        key: row.key,
        value: row.value,
        tokenCount,
        rarityPercent,
    };
}

function mergeTokenDetailTraits(params: {
    normalizedTraits: TokenDetailTrait[];
    metadataTraits: TokenAttribute[];
}): TokenDetailTrait[] {
    const merged: TokenDetailTrait[] = [];
    const seen = new Set<string>();

    for (const trait of params.normalizedTraits) {
        const signature = `${trait.key}:${trait.value}`;
        if (seen.has(signature)) continue;
        seen.add(signature);
        merged.push(trait);
    }

    for (const trait of params.metadataTraits) {
        const signature = `${trait.key}:${trait.value}`;
        if (seen.has(signature)) continue;
        seen.add(signature);
        merged.push({
            key: trait.key,
            value: trait.value,
            tokenCount: null,
            rarityPercent: null,
        });
    }

    return merged.sort((a, b) => {
        const byKey = a.key.localeCompare(b.key);
        if (byKey !== 0) return byKey;
        return a.value.localeCompare(b.value);
    });
}

function parseTokenAttributes(raw: string | null): TokenAttribute[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        const normalized: TokenAttribute[] = [];
        for (const entry of parsed) {
            if (!entry || typeof entry !== "object") continue;
            const source = entry as { traitType?: unknown; value?: unknown };
            if (typeof source.traitType !== "string") continue;
            if (source.value === undefined || source.value === null) continue;
            const key = source.traitType.trim();
            const value = String(source.value).trim();
            if (!key || !value) continue;
            normalized.push({ key, value });
        }
        return normalized;
    } catch {
        return [];
    }
}
