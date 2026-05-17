import { db } from "../database/db.js";
import { MAX_PAGE_LIMIT } from "../config/pagination.js";
import { isTokenImageCachePublicPath } from "../media/token-image-cache-paths.js";
import {
    resolveTokenResourceUri,
    type TokenResourceUriOptions,
} from "../media/token-resource-uri.js";
import {
    ARTGOD_COLLECTION_COUNT_KIND,
    ARTGOD_SPAN_NAME,
    ARTGOD_SPAN_ATTRIBUTE,
} from "../observability/artgod-span-attributes.js";
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
    CollectionTokenScopeSummary,
    TraitCatalogFacet,
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
    buildTokenTraitRangeJoinClauses,
    groupTraitFilters,
    groupTraitRangeFilters,
    normalizeTraitFilters,
    normalizeTraitRangeFilters,
    resolveTraitFilterTokenCandidatesWithSpan,
    type TraitFilterTokenCandidates,
    type TraitFilterGroup,
    type TraitRangeFilterGroup,
} from "./trait-filters.js";
import { resolveOwnerTokenCandidatesWithSpan } from "./owner-token-candidates.js";
import {
    buildTokenCandidateWhereClauses,
    intersectTokenIdSets,
    type TokenCandidates,
} from "./token-candidates.js";

const TOKEN_IMAGE_SELECT_SQL = "COALESCE(ic.public_path, m.image) AS image";
const TOKEN_IMAGE_CACHE_JOIN_SQL =
    "LEFT JOIN token_image_cache ic ON ic.chain_id = t.chain_id " +
    "AND ic.collection_id = t.collection_id " +
    "AND ic.token_id = t.token_id " +
    "AND ic.public_path IS NOT NULL " +
    "AND ic.source_image_url = m.image ";

export type CollectionReadModelMediaOptions = {
    ipfsGatewayOrigin?: string;
};

type CollectionRow = {
    chain_id: number;
    collection_id: number;
    slug: string;
    address: string;
    standard: string;
    status: string;
    deployment_block: number | null;
    bootstrap_anchor_block: number | null;
    token_scope_kind: string;
    scope_start_token_id: string | null;
    scope_total_supply: number | null;
    scope_token_count: number | null;
    created_at: string;
    updated_at: string;
};

type TokenRow = {
    token_id: string;
    name: string | null;
    image: string | null;
    listing_price: string | null;
    listing_currency: string | null;
    metadata_updated_at: string | null;
};

type ListedTokenRow = TokenRow & {
    total_count?: number | bigint | null;
};

type HydratedTokenRow = TokenRow & {
    attributes: TokenAttribute[];
};

type TokenDetailRow = {
    token_id: string;
    name: string | null;
    image: string | null;
    animation_url: string | null;
    listing_price: string | null;
    listing_currency: string | null;
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

type TokenListingHydrationRow = {
    token_id: string;
    price: string | null;
    currency: string | null;
};

type TokenAttributeRow = {
    token_id: string;
    key: string;
    value: string;
};

type TokenCurrentHolderRow = {
    owner: string;
};

type TraitFacetRow = {
    key: string;
    value: string;
    token_count: number;
};

type TraitFacetRangeRow = {
    key: string;
    min_value: string | null;
    max_value: string | null;
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

const TOKEN_SORT_BUCKET_SQL = "t.token_sort_bucket";
const TOKEN_SORT_LENGTH_SQL = "t.token_sort_length";
const TOKEN_SORT_VALUE_SQL = "t.token_sort_value";
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
const ATTRIBUTE_VALUE_NORMALIZED_NUMERIC_SQL =
    "CASE WHEN LTRIM(a.value, '0') = '' THEN '0' ELSE LTRIM(a.value, '0') END";
const COLLECTION_SELECT_COLUMNS =
    "chain_id, collection_id, slug, address, standard, status, deployment_block, bootstrap_anchor_block, " +
    "token_scope_kind, scope_start_token_id, scope_total_supply, " +
    "(SELECT COUNT(1) FROM collection_scope_tokens " +
    "WHERE collection_scope_tokens.chain_id = collections.chain_id " +
    "AND collection_scope_tokens.collection_id = collections.collection_id) AS scope_token_count, " +
    "created_at, updated_at";

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
    rangeOnlyKeys?: string[];
};

export type ListCollectionTraitCatalogParams = {
    chainId: number;
    collectionId: number;
    keys: string[];
    scopeTraitFilters?: TraitFilter[];
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
    private readonly tokenResourceOptions: TokenResourceUriOptions;

    constructor(
        supportedListingCurrencies: string[],
        private readonly apm: ApmPort = NOOP_APM,
        mediaOptions: CollectionReadModelMediaOptions = {},
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
        this.tokenResourceOptions = {
            ipfsGatewayOrigin: mediaOptions.ipfsGatewayOrigin,
        };
    }

    private selectCollectionBySlug = db.prepare<{
        chainId: number;
        slug: string;
    }>(
        `SELECT ${COLLECTION_SELECT_COLUMNS} ` +
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

    private selectTokenCurrentHolderRow = db.prepare<[number, number, string]>(
        "SELECT owner AS owner " +
            "FROM nft_balances " +
            "WHERE chain_id = ? AND collection_id = ? AND token_id = ? " +
            "AND CAST(amount AS INTEGER) > 0 " +
            "ORDER BY owner ASC " +
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
        `SELECT t.token_id, ${TOKEN_IMAGE_SELECT_SQL}, m.animation_url ` +
            "FROM tokens t " +
            "LEFT JOIN token_metadata m ON m.chain_id = t.chain_id " +
            "AND m.collection_id = t.collection_id " +
            "AND m.token_id = t.token_id " +
            TOKEN_IMAGE_CACHE_JOIN_SQL +
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
            `SELECT ${COLLECTION_SELECT_COLUMNS} ` +
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
            traitRangeFilterGroups: params.traitRangeFilterGroups,
        });
        const filterTokenCandidates = resolveCollectionTokenCandidates({
            apm: this.apm,
            spanAttributes,
            chainId: params.chainId,
            collectionId: params.collectionId,
            traitFilterGroups: params.traitFilterGroups,
            owner: params.owner,
        });
        if (filterTokenCandidates.isEmpty) {
            return emptyTokenCursorPage(params.limit);
        }
        const {
            whereClauses: tokenCandidateWhereClauses,
            values: tokenCandidateValues,
        } = buildTokenCandidateWhereClauses({
            tokenIds: filterTokenCandidates.tokenIds,
            tokenColumnSql: "t.token_id",
        });
        const querySpanAttributes = withCandidateSpanAttributes(
            spanAttributes,
            filterTokenCandidates,
        );
        const cursorSortKey = params.cursor
            ? toTokenSortKey(params.cursor.tokenId)
            : null;
        const tokenWhereClauses = [
            ...baseWhereClauses,
            ...tokenCandidateWhereClauses,
        ];
        const whereClauses = [...tokenWhereClauses];
        const tokenWhereValues = [...baseWhereValues, ...tokenCandidateValues];
        const values = [...baseJoinValues, ...tokenWhereValues];

        if (cursorSortKey) {
            whereClauses.push(`${TOKEN_SORT_KEY_SQL} > (?, ?, ?, ?)`);
            values.push(...tokenSortKeyParams(cursorSortKey));
        }

        const sql =
            `SELECT t.token_id, m.name, ${TOKEN_IMAGE_SELECT_SQL}, NULL AS listing_price, NULL AS listing_currency, m.updated_at AS metadata_updated_at ` +
            "FROM tokens t " +
            `${baseJoinClauses.join(" ")} ` +
            "LEFT JOIN token_metadata m ON m.chain_id = t.chain_id " +
            "AND m.collection_id = t.collection_id " +
            "AND m.token_id = t.token_id " +
            TOKEN_IMAGE_CACHE_JOIN_SQL +
            `WHERE ${whereClauses.join(" AND ")} ` +
            `ORDER BY ${TOKEN_ORDER_BY_ASC_SQL} ` +
            "LIMIT ?";

        values.push(params.limit + 1);

        const rows = this.apm.withSyncSpan(
            "backend.collection.db.tokens_page",
            querySpanAttributes,
            () => db.raw.prepare(sql).all(...values) as TokenRow[],
        );
        const hasNext = rows.length > params.limit;
        const pageRows = hasNext ? rows.slice(0, params.limit) : rows;
        const hydratedPageRows = this.apm.withSyncSpan(
            "backend.collection.db.tokens_listing_hydration",
            {
                ...querySpanAttributes,
                [ARTGOD_SPAN_ATTRIBUTE.TokensCount]: pageRows.length,
            },
            () =>
                hydrateTokenRowsWithCheapestListings({
                    rows: pageRows,
                    chainId: params.chainId,
                    collectionId: params.collectionId,
                    supportedCurrencies: this.supportedListingCurrencies,
                    nowSeconds: params.nowSeconds,
                }),
        );
        const items = hydrateTokenRowsWithNormalizedAttributes({
            rows: hydratedPageRows,
            chainId: params.chainId,
            collectionId: params.collectionId,
        }).map((row) => mapTokenRow(row, this.tokenResourceOptions));

        const prevCursor = params.cursor
            ? this.apm.withSyncSpan(
                  "backend.collection.db.tokens_prev_cursor",
                  querySpanAttributes,
                  () =>
                      derivePrevCursor({
                          baseJoinClauses,
                          baseJoinValues,
                          baseWhereClauses: tokenWhereClauses,
                          baseWhereValues: tokenWhereValues,
                          cursor: params.cursor,
                          pageRows,
                          limit: params.limit,
                      }),
              )
            : null;

        const totalItems = this.apm.withSyncSpan(
            "backend.collection.db.tokens_count",
            {
                ...querySpanAttributes,
                [ARTGOD_SPAN_ATTRIBUTE.CollectionCountKind]:
                    ARTGOD_COLLECTION_COUNT_KIND.Total,
            },
            () =>
                countMatchingTokens({
                    joinClauses: baseJoinClauses,
                    joinValues: baseJoinValues,
                    whereClauses: tokenWhereClauses,
                    whereValues: tokenWhereValues,
                }),
        );
        const beforeItems = cursorSortKey
            ? this.apm.withSyncSpan(
                  "backend.collection.db.tokens_count",
                  {
                      ...querySpanAttributes,
                      [ARTGOD_SPAN_ATTRIBUTE.CollectionCountKind]:
                          ARTGOD_COLLECTION_COUNT_KIND.BeforeCursor,
                  },
                  () =>
                      countMatchingTokens({
                          joinClauses: baseJoinClauses,
                          joinValues: baseJoinValues,
                          whereClauses: [
                              ...tokenWhereClauses,
                              `${TOKEN_SORT_KEY_SQL} <= (?, ?, ?, ?)`,
                          ],
                          whereValues: [
                              ...tokenWhereValues,
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
            traitRangeFilterGroups: params.traitRangeFilterGroups,
        });
        const filterTokenCandidates = resolveCollectionTokenCandidates({
            apm: this.apm,
            spanAttributes,
            chainId: params.chainId,
            collectionId: params.collectionId,
            traitFilterGroups: params.traitFilterGroups,
            owner: params.owner,
        });
        if (filterTokenCandidates.isEmpty) {
            return emptyTokenCursorPage(params.limit);
        }
        const querySpanAttributes = withCandidateSpanAttributes(
            spanAttributes,
            filterTokenCandidates,
        );
        const listingValues = buildCheapestListingValues({
            chainId: params.chainId,
            collectionId: params.collectionId,
            supportedCurrencies: this.supportedListingCurrencies,
            nowSeconds: params.nowSeconds,
        });
        const constrainedListingValues =
            filterTokenCandidates.tokenIds === null
                ? listingValues
                : [...listingValues, ...filterTokenCandidates.tokenIds];
        const listingSql = buildCheapestListingSql(
            this.supportedListingCurrencies.length,
            filterTokenCandidates.tokenIds?.length ?? 0,
        );
        const cursorKey = params.cursor
            ? toListingCursorKey(
                  params.cursor.listingPrice,
                  params.cursor.tokenId,
              )
            : null;
        const whereClauses = [...baseWhereClauses];
        const values: unknown[] = [
            ...baseJoinValues,
            ...constrainedListingValues,
            ...baseWhereValues,
        ];

        if (cursorKey) {
            whereClauses.push(
                `${LISTED_TOKEN_SORT_KEY_SQL} > (?, ?, ?, ?, ?, ?)`,
            );
            values.push(...listingCursorKeyParams(cursorKey));
        }

        const totalCountSelect =
            cursorKey === null ? ", COUNT(*) OVER () AS total_count " : " ";
        const sql =
            `SELECT t.token_id, m.name, ${TOKEN_IMAGE_SELECT_SQL}, l.price AS listing_price, l.currency AS listing_currency, m.updated_at AS metadata_updated_at` +
            totalCountSelect +
            "FROM tokens t " +
            `${baseJoinClauses.join(" ")} ` +
            `JOIN (${listingSql}) l ` +
            "ON l.collection_id = t.collection_id " +
            "AND l.token_id = t.token_id " +
            "LEFT JOIN token_metadata m ON m.chain_id = t.chain_id " +
            "AND m.collection_id = t.collection_id " +
            "AND m.token_id = t.token_id " +
            TOKEN_IMAGE_CACHE_JOIN_SQL +
            `WHERE ${whereClauses.join(" AND ")} ` +
            `ORDER BY ${LISTED_ORDER_BY_ASC_SQL} ` +
            "LIMIT ?";

        const rows = this.apm.withSyncSpan(
            "backend.collection.db.tokens_page",
            querySpanAttributes,
            () =>
                db.raw
                    .prepare(sql)
                    .all(...values, params.limit + 1) as ListedTokenRow[],
        );
        const hasNext = rows.length > params.limit;
        const pageRows = hasNext ? rows.slice(0, params.limit) : rows;
        const items = hydrateTokenRowsWithNormalizedAttributes({
            rows: pageRows,
            chainId: params.chainId,
            collectionId: params.collectionId,
        }).map((row) => mapTokenRow(row, this.tokenResourceOptions));

        const prevCursor = params.cursor
            ? this.apm.withSyncSpan(
                  "backend.collection.db.tokens_prev_cursor",
                  querySpanAttributes,
                  () =>
                      deriveListedPrevCursor({
                          listingSql,
                          baseJoinClauses,
                          baseJoinValues,
                          listingValues: constrainedListingValues,
                          baseWhereClauses,
                          baseWhereValues,
                          cursor: params.cursor,
                          pageRows,
                          limit: params.limit,
                      }),
              )
            : null;

        const totalItems =
            cursorKey === null
                ? normalizeSqliteCount(rows[0]?.total_count)
                : this.apm.withSyncSpan(
                      "backend.collection.db.tokens_count",
                      {
                          ...querySpanAttributes,
                          [ARTGOD_SPAN_ATTRIBUTE.CollectionCountKind]:
                              ARTGOD_COLLECTION_COUNT_KIND.Total,
                      },
                      () =>
                          countMatchingListedTokens({
                              joinClauses: baseJoinClauses,
                              joinValues: baseJoinValues,
                              listingSql,
                              listingValues: constrainedListingValues,
                              whereClauses: baseWhereClauses,
                              whereValues: baseWhereValues,
                          }),
                  );
        const beforeItems = cursorKey
            ? this.apm.withSyncSpan(
                  "backend.collection.db.tokens_count",
                  {
                      ...querySpanAttributes,
                      [ARTGOD_SPAN_ATTRIBUTE.CollectionCountKind]:
                          ARTGOD_COLLECTION_COUNT_KIND.BeforeCursor,
                  },
                  () =>
                      countMatchingListedTokens({
                          joinClauses: baseJoinClauses,
                          joinValues: baseJoinValues,
                          listingSql,
                          listingValues: constrainedListingValues,
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
            traitRangeFilterGroups: params.traitRangeFilterGroups,
        });
        const filterTokenCandidates = resolveCollectionTokenCandidates({
            apm: this.apm,
            spanAttributes,
            chainId: params.chainId,
            collectionId: params.collectionId,
            traitFilterGroups: params.traitFilterGroups,
            owner: params.owner,
        });
        if (filterTokenCandidates.isEmpty) {
            return emptyTokenCursorPage(params.limit);
        }
        const {
            whereClauses: tokenCandidateWhereClauses,
            values: tokenCandidateValues,
        } = buildTokenCandidateWhereClauses({
            tokenIds: filterTokenCandidates.tokenIds,
            tokenColumnSql: "t.token_id",
        });
        const querySpanAttributes = withCandidateSpanAttributes(
            spanAttributes,
            filterTokenCandidates,
        );
        const listingSql = buildCheapestListingSql(
            this.supportedListingCurrencies.length,
            filterTokenCandidates.tokenIds?.length ?? 0,
        );
        const baseListingValues = buildCheapestListingValues({
            chainId: params.chainId,
            collectionId: params.collectionId,
            supportedCurrencies: this.supportedListingCurrencies,
            nowSeconds: params.nowSeconds,
        });
        const listingValues =
            filterTokenCandidates.tokenIds === null
                ? baseListingValues
                : [...baseListingValues, ...filterTokenCandidates.tokenIds];
        const cursorKey = params.cursor
            ? toListedThenUnlistedCursorKey(
                  params.cursor.listingPrice,
                  params.cursor.tokenId,
              )
            : null;
        const tokenWhereClauses = [
            ...baseWhereClauses,
            ...tokenCandidateWhereClauses,
        ];
        const whereClauses = [...tokenWhereClauses];
        const tokenWhereValues = [...baseWhereValues, ...tokenCandidateValues];
        const values: unknown[] = [
            ...baseJoinValues,
            ...listingValues,
            ...tokenWhereValues,
        ];

        if (cursorKey) {
            whereClauses.push(
                `${LISTED_THEN_UNLISTED_TOKEN_SORT_KEY_SQL} > (?, ?, ?, ?, ?, ?, ?)`,
            );
            values.push(...listedThenUnlistedCursorKeyParams(cursorKey));
        }

        const sql =
            `SELECT t.token_id, m.name, ${TOKEN_IMAGE_SELECT_SQL}, l.price AS listing_price, l.currency AS listing_currency, m.updated_at AS metadata_updated_at ` +
            "FROM tokens t " +
            `${baseJoinClauses.join(" ")} ` +
            `LEFT JOIN (${listingSql}) l ` +
            "ON l.collection_id = t.collection_id " +
            "AND l.token_id = t.token_id " +
            "LEFT JOIN token_metadata m ON m.chain_id = t.chain_id " +
            "AND m.collection_id = t.collection_id " +
            "AND m.token_id = t.token_id " +
            TOKEN_IMAGE_CACHE_JOIN_SQL +
            `WHERE ${whereClauses.join(" AND ")} ` +
            `ORDER BY ${LISTED_THEN_UNLISTED_ORDER_BY_ASC_SQL} ` +
            "LIMIT ?";

        const rows = this.apm.withSyncSpan(
            "backend.collection.db.tokens_page",
            querySpanAttributes,
            () =>
                db.raw
                    .prepare(sql)
                    .all(...values, params.limit + 1) as TokenRow[],
        );
        const hasNext = rows.length > params.limit;
        const pageRows = hasNext ? rows.slice(0, params.limit) : rows;
        const items = hydrateTokenRowsWithNormalizedAttributes({
            rows: pageRows,
            chainId: params.chainId,
            collectionId: params.collectionId,
        }).map((row) => mapTokenRow(row, this.tokenResourceOptions));

        const prevCursor = params.cursor
            ? this.apm.withSyncSpan(
                  "backend.collection.db.tokens_prev_cursor",
                  querySpanAttributes,
                  () =>
                      deriveListedThenUnlistedPrevCursor({
                          listingSql,
                          listingValues,
                          baseJoinClauses,
                          baseJoinValues,
                          baseWhereClauses: tokenWhereClauses,
                          baseWhereValues: tokenWhereValues,
                          cursor: params.cursor,
                          pageRows,
                          limit: params.limit,
                      }),
              )
            : null;

        const totalItems = this.apm.withSyncSpan(
            "backend.collection.db.tokens_count",
            {
                ...querySpanAttributes,
                [ARTGOD_SPAN_ATTRIBUTE.CollectionCountKind]:
                    ARTGOD_COLLECTION_COUNT_KIND.Total,
            },
            () =>
                countMatchingTokens({
                    joinClauses: baseJoinClauses,
                    joinValues: baseJoinValues,
                    whereClauses: tokenWhereClauses,
                    whereValues: tokenWhereValues,
                }),
        );
        const beforeItems = cursorKey
            ? this.apm.withSyncSpan(
                  "backend.collection.db.tokens_count",
                  {
                      ...querySpanAttributes,
                      [ARTGOD_SPAN_ATTRIBUTE.CollectionCountKind]:
                          ARTGOD_COLLECTION_COUNT_KIND.BeforeCursor,
                  },
                  () =>
                      countMatchingMixedTokens({
                          joinClauses: baseJoinClauses,
                          joinValues: baseJoinValues,
                          listingSql,
                          listingValues,
                          whereClauses: [
                              ...tokenWhereClauses,
                              `${LISTED_THEN_UNLISTED_TOKEN_SORT_KEY_SQL} <= (?, ?, ?, ?, ?, ?, ?)`,
                          ],
                          whereValues: [
                              ...tokenWhereValues,
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
        const rangeOnlyKeys = normalizeTraitKeyList(
            options.rangeOnlyKeys,
        ).filter((key) => !excludeKeys.includes(key));
        const valueExcludeKeys = normalizeTraitKeyList([
            ...excludeKeys,
            ...rangeOnlyKeys,
        ]);
        const normalizedOwner = owner ? normalizeAddressRef(owner) : undefined;
        const facetBaseSpanAttributes = {
            [ARTGOD_SPAN_ATTRIBUTE.ChainId]: chainId,
            [ARTGOD_SPAN_ATTRIBUTE.CollectionId]: collectionId,
            [ARTGOD_SPAN_ATTRIBUTE.CollectionOwnerPresent]:
                Boolean(normalizedOwner),
            [ARTGOD_SPAN_ATTRIBUTE.CollectionExcludeKeysCount]:
                valueExcludeKeys.length,
            [ARTGOD_SPAN_ATTRIBUTE.CollectionRangeOnlyKeysCount]:
                rangeOnlyKeys.length,
        };
        const ownerTokenCandidates = resolveCollectionOwnerTokenCandidates({
            apm: this.apm,
            spanAttributes: facetBaseSpanAttributes,
            chainId,
            collectionId,
            owner: normalizedOwner,
        });
        if (ownerTokenCandidates.isEmpty) {
            return [];
        }
        const facetSpanAttributes = withCandidateSpanAttributes(
            facetBaseSpanAttributes,
            ownerTokenCandidates,
        );
        const rangeFacetSpanAttributes = withCandidateSpanAttributes(
            {
                [ARTGOD_SPAN_ATTRIBUTE.ChainId]: chainId,
                [ARTGOD_SPAN_ATTRIBUTE.CollectionId]: collectionId,
                [ARTGOD_SPAN_ATTRIBUTE.CollectionOwnerPresent]:
                    Boolean(normalizedOwner),
                [ARTGOD_SPAN_ATTRIBUTE.CollectionRangeOnlyKeysCount]:
                    rangeOnlyKeys.length,
            },
            ownerTokenCandidates,
        );
        const rows = this.apm.withSyncSpan(
            "backend.collection.db.trait_facets",
            facetSpanAttributes,
            () =>
                ownerTokenCandidates.tokenIds !== null
                    ? this.selectOwnerScopedTraitFacetRowsWithOptions(
                          chainId,
                          collectionId,
                          ownerTokenCandidates.tokenIds,
                          valueExcludeKeys,
                      )
                    : this.selectTraitFacetRowsWithOptions(
                          chainId,
                          collectionId,
                          valueExcludeKeys,
                      ),
        );
        const rangeRows =
            rangeOnlyKeys.length === 0
                ? []
                : this.apm.withSyncSpan(
                      "backend.collection.db.trait_range_facets",
                      rangeFacetSpanAttributes,
                      () =>
                          ownerTokenCandidates.tokenIds !== null
                              ? this.selectOwnerScopedTraitRangeRowsWithOptions(
                                    chainId,
                                    collectionId,
                                    ownerTokenCandidates.tokenIds,
                                    rangeOnlyKeys,
                                )
                              : this.selectTraitRangeRowsWithOptions(
                                    chainId,
                                    collectionId,
                                    rangeOnlyKeys,
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
        for (const row of rangeRows) {
            if (byKey.has(row.key)) {
                continue;
            }
            const minValue = normalizeRangeBound(row.min_value);
            const maxValue = normalizeRangeBound(row.max_value);
            if (minValue === null && maxValue === null) {
                continue;
            }

            const facet = {
                key: row.key,
                displayKind: TRAIT_FILTER_DISPLAY_KIND.Range,
                minValue,
                maxValue,
                values: [],
            };
            byKey.set(row.key, facet);
            facets.push(facet);
        }
        return facets;
    }

    // Lists exact minted value counts for requested trait keys within an optional trait scope.
    listCollectionTraitCatalog(
        params: ListCollectionTraitCatalogParams,
    ): TraitCatalogFacet[] {
        const keys = normalizeTraitKeyList(params.keys);
        if (keys.length === 0) {
            throw new ReadModelBadRequestError(
                "Trait catalog keys are required",
            );
        }
        const scopeTraitFilters = normalizeTraitFilters(
            params.scopeTraitFilters ?? [],
        );
        const traitFilterGroups = groupTraitFilters(scopeTraitFilters);
        const spanAttributes = {
            [ARTGOD_SPAN_ATTRIBUTE.ChainId]: params.chainId,
            [ARTGOD_SPAN_ATTRIBUTE.CollectionId]: params.collectionId,
            [ARTGOD_SPAN_ATTRIBUTE.CollectionTraitCatalogKeysCount]:
                keys.length,
            [ARTGOD_SPAN_ATTRIBUTE.CollectionTraitFiltersCount]:
                traitFilterGroups.length,
        };
        const tokenCandidates = resolveCollectionExactTraitTokenCandidates({
            apm: this.apm,
            spanAttributes,
            chainId: params.chainId,
            collectionId: params.collectionId,
            traitFilterGroups,
        });
        if (tokenCandidates.isEmpty) {
            return buildTraitCatalogFacets(keys, []);
        }

        const rows = this.apm.withSyncSpan(
            "backend.collection.db.trait_catalog",
            withCandidateSpanAttributes(spanAttributes, tokenCandidates),
            () =>
                tokenCandidates.tokenIds === null
                    ? this.selectTraitCatalogRowsWithOptions(
                          params.chainId,
                          params.collectionId,
                          keys,
                      )
                    : this.selectScopedTraitCatalogRowsWithOptions(
                          params.chainId,
                          params.collectionId,
                          tokenCandidates.tokenIds,
                          keys,
                      ),
        );
        return buildTraitCatalogFacets(keys, rows);
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

    private selectTraitCatalogRowsWithOptions(
        chainId: number,
        collectionId: number,
        keys: string[],
    ): TraitFacetRow[] {
        const keyPlaceholders = keys.map(() => "?").join(", ");
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
                    `AND attribute_keys.key IN (${keyPlaceholders}) ` +
                    "ORDER BY attribute_keys.key ASC, collection_trait_stats.token_count ASC, attributes.value ASC",
            )
            .all(chainId, collectionId, ...keys) as TraitFacetRow[];
    }

    private selectScopedTraitCatalogRowsWithOptions(
        chainId: number,
        collectionId: number,
        tokenIds: string[],
        keys: string[],
    ): TraitFacetRow[] {
        const { whereClauses, values: tokenCandidateValues } =
            buildTokenCandidateWhereClauses({
                tokenIds,
                tokenColumnSql: "ta.token_id",
            });
        const keyPlaceholders = keys.map(() => "?").join(", ");
        return db.raw
            .prepare(
                "SELECT ak.key AS key, a.value AS value, COUNT(DISTINCT ta.token_id) AS token_count " +
                    "FROM token_attributes ta " +
                    "JOIN attributes a ON a.id = ta.attribute_id " +
                    "AND a.chain_id = ta.chain_id " +
                    "AND a.collection_id = ta.collection_id " +
                    "JOIN attribute_keys ak ON ak.id = a.attribute_key_id " +
                    "AND ak.chain_id = a.chain_id " +
                    "AND ak.collection_id = a.collection_id " +
                    "WHERE ta.chain_id = ? " +
                    "AND ta.collection_id = ? " +
                    `${whereClauses.map((clause) => `AND ${clause} `).join("")}` +
                    `AND ak.key IN (${keyPlaceholders}) ` +
                    "GROUP BY ak.key, a.value " +
                    "ORDER BY ak.key ASC, token_count ASC, a.value ASC",
            )
            .all(
                chainId,
                collectionId,
                ...tokenCandidateValues,
                ...keys,
            ) as TraitFacetRow[];
    }

    private selectOwnerScopedTraitFacetRowsWithOptions(
        chainId: number,
        collectionId: number,
        tokenIds: string[],
        excludeKeys: string[],
    ): TraitFacetRow[] {
        const { whereClauses, values: tokenCandidateValues } =
            buildTokenCandidateWhereClauses({
                tokenIds,
                tokenColumnSql: "ta.token_id",
            });
        const excludeKeyClause =
            excludeKeys.length === 0
                ? ""
                : `AND ak.key NOT IN (${excludeKeys.map(() => "?").join(", ")}) `;
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
                    `${whereClauses.map((clause) => `AND ${clause} `).join("")}` +
                    excludeKeyClause +
                    "GROUP BY ak.key, a.value " +
                    "ORDER BY ak.key ASC, token_count ASC, a.value ASC",
            )
            .all(
                chainId,
                collectionId,
                ...tokenCandidateValues,
                ...excludeKeys,
            ) as TraitFacetRow[];
    }

    private selectTraitRangeRowsWithOptions(
        chainId: number,
        collectionId: number,
        rangeOnlyKeys: string[],
    ): TraitFacetRangeRow[] {
        return rangeOnlyKeys.flatMap((key) => {
            const minValue = this.selectTraitRangeBound({
                chainId,
                collectionId,
                key,
                direction: "ASC",
            });
            const maxValue = this.selectTraitRangeBound({
                chainId,
                collectionId,
                key,
                direction: "DESC",
            });

            return minValue === null && maxValue === null
                ? []
                : [{ key, min_value: minValue, max_value: maxValue }];
        });
    }

    private selectOwnerScopedTraitRangeRowsWithOptions(
        chainId: number,
        collectionId: number,
        tokenIds: string[],
        rangeOnlyKeys: string[],
    ): TraitFacetRangeRow[] {
        return rangeOnlyKeys.flatMap((key) => {
            const minValue = this.selectOwnerScopedTraitRangeBound({
                chainId,
                collectionId,
                tokenIds,
                key,
                direction: "ASC",
            });
            const maxValue = this.selectOwnerScopedTraitRangeBound({
                chainId,
                collectionId,
                tokenIds,
                key,
                direction: "DESC",
            });

            return minValue === null && maxValue === null
                ? []
                : [{ key, min_value: minValue, max_value: maxValue }];
        });
    }

    private selectTraitRangeBound(params: {
        chainId: number;
        collectionId: number;
        key: string;
        direction: "ASC" | "DESC";
    }): string | null {
        const row = db.raw
            .prepare(
                "SELECT a.value AS value " +
                    "FROM attribute_keys ak " +
                    "JOIN collection_trait_stats cts ON cts.attribute_key_id = ak.id " +
                    "AND cts.chain_id = ak.chain_id " +
                    "AND cts.collection_id = ak.collection_id " +
                    "JOIN attributes a ON a.id = cts.attribute_id " +
                    "AND a.chain_id = cts.chain_id " +
                    "AND a.collection_id = cts.collection_id " +
                    "WHERE ak.chain_id = ? AND ak.collection_id = ? " +
                    "AND ak.key = ? " +
                    "AND a.value <> '' AND a.value NOT GLOB '*[^0-9]*' " +
                    `ORDER BY LENGTH(${ATTRIBUTE_VALUE_NORMALIZED_NUMERIC_SQL}) ${params.direction}, ` +
                    `${ATTRIBUTE_VALUE_NORMALIZED_NUMERIC_SQL} ${params.direction} ` +
                    "LIMIT 1",
            )
            .get(params.chainId, params.collectionId, params.key) as
            | { value: string }
            | undefined;
        return row?.value ?? null;
    }

    private selectOwnerScopedTraitRangeBound(params: {
        chainId: number;
        collectionId: number;
        tokenIds: string[];
        key: string;
        direction: "ASC" | "DESC";
    }): string | null {
        const { whereClauses, values: tokenCandidateValues } =
            buildTokenCandidateWhereClauses({
                tokenIds: params.tokenIds,
                tokenColumnSql: "ta.token_id",
            });
        const row = db.raw
            .prepare(
                "SELECT a.value AS value " +
                    "FROM attribute_keys ak " +
                    "JOIN attributes a ON a.attribute_key_id = ak.id " +
                    "AND a.chain_id = ak.chain_id " +
                    "AND a.collection_id = ak.collection_id " +
                    "JOIN token_attributes ta ON ta.attribute_id = a.id " +
                    "AND ta.chain_id = a.chain_id " +
                    "AND ta.collection_id = a.collection_id " +
                    "WHERE ak.chain_id = ? " +
                    "AND ak.collection_id = ? " +
                    "AND ak.key = ? " +
                    "AND a.value <> '' AND a.value NOT GLOB '*[^0-9]*' " +
                    `${whereClauses.map((clause) => `AND ${clause} `).join("")}` +
                    `ORDER BY LENGTH(${ATTRIBUTE_VALUE_NORMALIZED_NUMERIC_SQL}) ${params.direction}, ` +
                    `${ATTRIBUTE_VALUE_NORMALIZED_NUMERIC_SQL} ${params.direction} ` +
                    "LIMIT 1",
            )
            .get(
                params.chainId,
                params.collectionId,
                params.key,
                ...tokenCandidateValues,
            ) as { value: string } | undefined;
        return row?.value ?? null;
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
        const attributes = attributeRows.map((item) =>
            mapTokenDetailTraitRow(item, totalItems),
        );

        return {
            tokenId: row.token_id,
            name: row.name ?? null,
            image: this.resolveImagePresentation(row.image),
            animationUrl: this.resolveMediaPresentation(row.animation_url),
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
            image: this.resolveImagePresentation(row.image),
            animationUrl: this.resolveMediaPresentation(row.animation_url),
        };
    }

    private selectTokenDetailRow(params: {
        chainId: number;
        collectionId: number;
        tokenId: string;
    }): TokenDetailRow | undefined {
        const listingSql = buildCheapestListingSql(
            this.supportedListingCurrencies.length,
            1,
        );
        const listingValues = buildCheapestListingValues({
            chainId: params.chainId,
            collectionId: params.collectionId,
            supportedCurrencies: this.supportedListingCurrencies,
            nowSeconds: Math.floor(Date.now() / 1000),
        });

        return db.raw
            .prepare(
                `SELECT t.token_id, m.name, ${TOKEN_IMAGE_SELECT_SQL}, m.animation_url, l.price AS listing_price, l.currency AS listing_currency, m.updated_at AS metadata_updated_at ` +
                    "FROM tokens t " +
                    "LEFT JOIN token_metadata m ON m.chain_id = t.chain_id " +
                    "AND m.collection_id = t.collection_id " +
                    "AND m.token_id = t.token_id " +
                    TOKEN_IMAGE_CACHE_JOIN_SQL +
                    `LEFT JOIN (${listingSql}) l ` +
                    "ON l.collection_id = t.collection_id " +
                    "AND l.token_id = t.token_id " +
                    "WHERE t.chain_id = ? AND t.collection_id = ? AND t.token_id = ? " +
                    "LIMIT 1",
            )
            .get(
                ...listingValues,
                params.tokenId,
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
            ? buildCheapestListingSql(
                  this.supportedListingCurrencies.length,
                  tokenIds.length,
              )
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
                `SELECT t.token_id, m.name, ${TOKEN_IMAGE_SELECT_SQL}, ` +
                    (includeListings
                        ? "l.price AS listing_price, l.currency AS listing_currency, "
                        : "NULL AS listing_price, NULL AS listing_currency, ") +
                    "m.updated_at AS metadata_updated_at " +
                    "FROM tokens t " +
                    (includeListings
                        ? `LEFT JOIN (${listingSql}) l ON l.collection_id = t.collection_id AND l.token_id = t.token_id `
                        : "") +
                    "LEFT JOIN token_metadata m ON m.chain_id = t.chain_id " +
                    "AND m.collection_id = t.collection_id " +
                    "AND m.token_id = t.token_id " +
                    TOKEN_IMAGE_CACHE_JOIN_SQL +
                    "WHERE t.chain_id = ? AND t.collection_id = ? " +
                    `AND t.token_id IN (${placeholders})`,
            )
            .all(
                ...listingValues,
                ...(includeListings ? tokenIds : []),
                params.chainId,
                params.collectionId,
                ...tokenIds,
            ) as TokenRow[];

        const hydratedRows = hydrateTokenRowsWithNormalizedAttributes({
            rows,
            chainId: params.chainId,
            collectionId: params.collectionId,
        });
        const byId = new Map(
            hydratedRows.map((row) => [
                row.token_id,
                mapTokenRow(row, this.tokenResourceOptions),
            ]),
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

    private resolveImagePresentation(value: string | null): string | null {
        return resolveTokenImagePresentation(value, this.tokenResourceOptions);
    }

    private resolveMediaPresentation(value: string | null): string | null {
        return resolveTokenResourceUri(value, this.tokenResourceOptions);
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

function normalizeSqliteCount(
    value: number | bigint | null | undefined,
): number {
    if (value === undefined || value === null) return 0;
    return typeof value === "bigint" ? Number(value) : value;
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

function emptyTokenCursorPage(limit: number): TokenCursorPage {
    return {
        items: [],
        prevCursor: null,
        nextCursor: null,
        limit,
        totalItems: 0,
        rangeStart: 0,
        rangeEnd: 0,
        currentPage: 0,
        totalPages: 0,
    };
}

function hydrateTokenRowsWithCheapestListings(params: {
    rows: TokenRow[];
    chainId: number;
    collectionId: number;
    supportedCurrencies: string[];
    nowSeconds: number;
}): TokenRow[] {
    const tokenIds = params.rows.map((row) => row.token_id);
    if (tokenIds.length === 0) {
        return params.rows;
    }

    const listingRows = db.raw
        .prepare(
            buildCheapestListingSql(
                params.supportedCurrencies.length,
                tokenIds.length,
            ),
        )
        .all(
            ...buildCheapestListingValues({
                chainId: params.chainId,
                collectionId: params.collectionId,
                supportedCurrencies: params.supportedCurrencies,
                nowSeconds: params.nowSeconds,
            }),
            ...tokenIds,
        ) as TokenListingHydrationRow[];
    const listingsByTokenId = new Map(
        listingRows.map((row) => [row.token_id, row]),
    );

    return params.rows.map((row) => {
        const listing = listingsByTokenId.get(row.token_id);
        if (!listing) {
            return row;
        }

        return {
            ...row,
            listing_price: listing.price,
            listing_currency: listing.currency,
        };
    });
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
                owner AS owner,
                SUM(CAST(amount AS INTEGER)) AS token_count_int
            FROM nft_balances
            WHERE chain_id = ? AND collection_id = ?
            GROUP BY owner
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
        [ARTGOD_SPAN_ATTRIBUTE.ChainId]: params.chainId,
        [ARTGOD_SPAN_ATTRIBUTE.CollectionId]: params.collectionId,
        [ARTGOD_SPAN_ATTRIBUTE.CollectionTokenStatus]: params.tokenStatus,
        [ARTGOD_SPAN_ATTRIBUTE.CollectionLimit]: params.limit,
        [ARTGOD_SPAN_ATTRIBUTE.CollectionCursorPresent]: params.cursorPresent,
        [ARTGOD_SPAN_ATTRIBUTE.CollectionTraitFiltersCount]:
            params.traitFilterGroups.length,
        [ARTGOD_SPAN_ATTRIBUTE.CollectionTraitRangesCount]:
            params.traitRangeFilterGroups.length,
        [ARTGOD_SPAN_ATTRIBUTE.CollectionOwnerPresent]: Boolean(params.owner),
    };
}

function resolveCollectionExactTraitTokenCandidates(params: {
    apm: ApmPort;
    spanAttributes: SpanAttributes;
    chainId: number;
    collectionId: number;
    seedTokenIds?: string[];
    traitFilterGroups: TraitFilterGroup[];
}): TraitFilterTokenCandidates {
    return resolveTraitFilterTokenCandidatesWithSpan({
        apm: params.apm,
        spanName: ARTGOD_SPAN_NAME.CollectionTraitFilterTokenCandidates,
        spanAttributes: params.spanAttributes,
        chainId: params.chainId,
        collectionId: params.collectionId,
        seedTokenIds: params.seedTokenIds,
        traitFilterGroups: params.traitFilterGroups,
        traitRangeFilterGroups: [],
    });
}

function resolveCollectionOwnerTokenCandidates(params: {
    apm: ApmPort;
    spanAttributes: SpanAttributes;
    chainId: number;
    collectionId: number;
    owner?: string;
}): TokenCandidates {
    return resolveOwnerTokenCandidatesWithSpan({
        apm: params.apm,
        spanName: ARTGOD_SPAN_NAME.CollectionOwnerTokenCandidates,
        spanAttributes: params.spanAttributes,
        chainId: params.chainId,
        collectionId: params.collectionId,
        owner: params.owner,
    });
}

function resolveCollectionTokenCandidates(params: {
    apm: ApmPort;
    spanAttributes: SpanAttributes;
    chainId: number;
    collectionId: number;
    traitFilterGroups: TraitFilterGroup[];
    owner?: string;
}): TokenCandidates {
    const ownerTokenCandidates = resolveCollectionOwnerTokenCandidates({
        apm: params.apm,
        spanAttributes: params.spanAttributes,
        chainId: params.chainId,
        collectionId: params.collectionId,
        owner: params.owner,
    });
    if (ownerTokenCandidates.isEmpty) {
        return ownerTokenCandidates;
    }

    const traitTokenCandidates = resolveCollectionExactTraitTokenCandidates({
        apm: params.apm,
        spanAttributes: params.spanAttributes,
        chainId: params.chainId,
        collectionId: params.collectionId,
        seedTokenIds: ownerTokenCandidates.tokenIds ?? undefined,
        traitFilterGroups: params.traitFilterGroups,
    });
    if (traitTokenCandidates.isEmpty) {
        return traitTokenCandidates;
    }

    return mergeTokenCandidates(traitTokenCandidates, ownerTokenCandidates);
}

function mergeTokenCandidates(
    ...candidates: TokenCandidates[]
): TokenCandidates {
    if (candidates.some((candidate) => candidate.isEmpty)) {
        return {
            tokenIds: [],
            isEmpty: true,
            candidateTokenIdsCount: 0,
        };
    }

    const concreteCandidateSets = candidates.flatMap((candidate) =>
        candidate.tokenIds === null ? [] : [candidate.tokenIds],
    );
    if (concreteCandidateSets.length === 0) {
        return {
            tokenIds: null,
            isEmpty: false,
        };
    }

    const tokenIds = intersectTokenIdSets(concreteCandidateSets);
    return {
        tokenIds,
        isEmpty: tokenIds.length === 0,
        candidateTokenIdsCount: tokenIds.length,
    };
}

function withCandidateSpanAttributes(
    spanAttributes: SpanAttributes,
    candidates: TokenCandidates,
): SpanAttributes {
    if (candidates.candidateTokenIdsCount === undefined) {
        return spanAttributes;
    }
    return {
        ...spanAttributes,
        [ARTGOD_SPAN_ATTRIBUTE.CollectionCandidateTokenIdsCount]:
            candidates.candidateTokenIdsCount,
    };
}

function buildTokenQueryParts(params: {
    chainId: number;
    collectionId: number;
    traitRangeFilterGroups: TraitRangeFilterGroup[];
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

function buildTraitCatalogFacets(
    keys: string[],
    rows: TraitFacetRow[],
): TraitCatalogFacet[] {
    const facets: TraitCatalogFacet[] = keys.map((key) => ({
        key,
        values: [],
    }));
    const byKey = new Map<string, TraitCatalogFacet>(
        facets.map((facet) => [facet.key, facet]),
    );
    for (const row of rows) {
        byKey.get(row.key)?.values.push({
            value: row.value,
            tokenCount: row.token_count,
        });
    }
    return facets;
}

export function applyTraitFilterPresentationToFacets(params: {
    facets: TraitFacet[];
    config: TraitFilterPresentationConfig;
}): TraitFacet[] {
    const rangeKeys = new Set(params.config.rangeKeys);

    return params.facets.map((facet) => {
        const isRange = rangeKeys.has(facet.key);
        const { minValue, maxValue } = isRange
            ? resolveNumericTraitBounds(facet)
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

function resolveNumericTraitBounds(facet: TraitFacet): {
    minValue: string | null;
    maxValue: string | null;
} {
    if (facet.minValue !== null || facet.maxValue !== null) {
        return {
            minValue: facet.minValue,
            maxValue: facet.maxValue,
        };
    }

    let minValue: bigint | null = null;
    let maxValue: bigint | null = null;

    for (const value of facet.values) {
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

function normalizeRangeBound(value: string | null): string | null {
    if (value === null) {
        return null;
    }
    const normalized = value.replace(/^0+/, "");
    return normalized || "0";
}

function buildCheapestListingSql(
    supportedCurrencyCount: number,
    tokenIdCount = 0,
): string {
    const currencyPlaceholders = new Array(supportedCurrencyCount)
        .fill("?")
        .join(", ");
    const tokenIdFilter =
        tokenIdCount > 0
            ? `AND o.token_id IN (${new Array(tokenIdCount).fill("?").join(", ")}) `
            : "";
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
        tokenIdFilter +
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
        tokenScope: mapCollectionTokenScope(row),
    };
}

function mapCollectionTokenScope(row: CollectionRow): CollectionTokenScopeSummary {
    if (row.token_scope_kind === "token_range") {
        return {
            label: "token range",
            items: [
                { label: "scope", value: "token range" },
                {
                    label: "start token",
                    value: row.scope_start_token_id ?? "unknown",
                },
                {
                    label: "total supply",
                    value:
                        row.scope_total_supply !== null
                            ? String(row.scope_total_supply)
                            : "unknown",
                },
            ],
        };
    }

    if (row.token_scope_kind === "explicit_token_ids") {
        return {
            label: "explicit token ids",
            items: [
                { label: "scope", value: "explicit token ids" },
                {
                    label: "token count",
                    value: String(row.scope_token_count ?? 0),
                },
            ],
        };
    }

    return {
        label: "all contract tokens",
        items: [{ label: "scope", value: "all contract tokens" }],
    };
}

function normalizeCollectionTokenId(tokenId: string): string {
    const normalized = tokenId.trim();
    if (!normalized) {
        throw new ReadModelBadRequestError("Invalid token_ref");
    }
    return normalized;
}

function mapTokenRow(
    row: HydratedTokenRow,
    tokenResourceOptions: TokenResourceUriOptions,
): TokenCard {
    return {
        tokenId: row.token_id,
        name: row.name ?? null,
        image: resolveTokenImagePresentation(row.image, tokenResourceOptions),
        traitSummary: null,
        listingPrice: row.listing_price ?? null,
        listingCurrency: row.listing_currency ?? null,
        attributes: row.attributes,
        hasMetadata: row.metadata_updated_at !== null,
        metadataUpdatedAt: row.metadata_updated_at,
    };
}

function resolveTokenImagePresentation(
    value: string | null,
    tokenResourceOptions: TokenResourceUriOptions,
): string | null {
    const normalized = value?.trim();
    if (!normalized) {
        return null;
    }
    if (isTokenImageCachePublicPath(normalized)) {
        return normalized;
    }
    return resolveTokenResourceUri(normalized, tokenResourceOptions);
}

function hydrateTokenRowsWithNormalizedAttributes(params: {
    rows: TokenRow[];
    chainId: number;
    collectionId: number;
}): HydratedTokenRow[] {
    if (params.rows.length === 0) {
        return [];
    }

    // Load normalized token traits once per page so card hydration stays bounded.
    const tokenIds = Array.from(
        new Set(params.rows.map((row) => row.token_id)),
    );
    const placeholders = tokenIds.map(() => "?").join(", ");
    const rows = db.raw
        .prepare(
            "SELECT ta.token_id AS token_id, ak.key AS key, a.value AS value " +
                "FROM token_attributes ta " +
                "JOIN attributes a ON a.id = ta.attribute_id " +
                "AND a.chain_id = ta.chain_id " +
                "AND a.collection_id = ta.collection_id " +
                "JOIN attribute_keys ak ON ak.id = a.attribute_key_id " +
                "AND ak.chain_id = a.chain_id " +
                "AND ak.collection_id = a.collection_id " +
                "WHERE ta.chain_id = ? AND ta.collection_id = ? " +
                `AND ta.token_id IN (${placeholders}) ` +
                "ORDER BY ta.token_id ASC, ak.key ASC, a.value ASC",
        )
        .all(
            params.chainId,
            params.collectionId,
            ...tokenIds,
        ) as TokenAttributeRow[];

    const attributesByTokenId = new Map<string, TokenAttribute[]>();
    for (const row of rows) {
        const attributes = attributesByTokenId.get(row.token_id) ?? [];
        attributes.push({ key: row.key, value: row.value });
        attributesByTokenId.set(row.token_id, attributes);
    }

    return params.rows.map((row) => ({
        ...row,
        attributes: attributesByTokenId.get(row.token_id) ?? [],
    }));
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
