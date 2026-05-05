# SQL-Backed Offer Search and Pagination Plan

Status: Deferred
Current behavior: token-scoped offer cards are grouped and paginated in backend application runtime

This document captures the schema and implementation findings for moving bidding offer search, grouping, and pagination closer to SQLite. Keep the current runtime implementation working for now; use this plan when the token-offer page needs DB-layer paging for scale.

## Goals

- Page token-scoped offers by grouped tokens, not by raw offer rows.
- Use normalized `orders` data directly for passive `orders` bid-book reads.
- Keep bot-snapshot rows as the competitive source when the bidding bot is running for a collection.
- Apply trait filters before pagination so counts, ranges, and cursors stay correct.
- Avoid reparsing OpenSea raw payload JSON in backend read paths.
- Keep backend application use cases transport-agnostic and move SQL-specific grouping/search into repository adapters.

## Current Runtime Behavior

The token-scoped offers page currently works by:

1. Loading active buy-side bid-book rows from the selected source.
2. Loading collection-wide bids from the same source.
3. Deriving the mute floor from the top collection-wide bid.
4. Filtering token-scoped offers below 10% of that top collection bid.
5. Grouping remaining offers by `token_id`.
6. Sorting each token's offers by unit price descending.
7. Sorting token groups by top offer price descending.
8. Loading token cards for all grouped token ids.
9. Applying selected token trait filters.
10. Slicing grouped token cards for pagination.

This is correct functionally, but it pulls too much work into application memory once token-scoped offer volume grows.

## Schema Findings

The normalized schema already contains most fields required for SQL-backed token-offer grouping.

`orders` contains:

- `id`: order id / order hash.
- `chain_id`, `collection_id`: collection scope.
- `side`, `source_status`, `fillability_status`: active buy-offer filtering.
- `source_scope_kind`: token, collection, attribute, or token set scope.
- `token_id`: exact token scope for token bids.
- `source_schema_json`: normalized collection or trait criteria schema.
- `source_encoded_token_ids`: encoded token-set payload when available.
- `local_token_set_status`, `token_set_id`, `token_set_schema_hash`: token-set resolution state.
- `maker`, `price`, `quantity`, `currency`, `valid_from`, `valid_until`.
- `created_at`, `updated_at`.

Token and trait data exists in:

- `tokens`
- `token_metadata`
- `attribute_keys`
- `attributes`
- `token_attributes`
- `collection_trait_stats`

Resolved token-set membership exists in:

- `token_sets`
- `token_sets_tokens`

Bot snapshot display rows exist in:

- `trading_bidding_bid_book_rows`
- `trading_bidding_collection_bid_book_state`

The OpenSea ingestion path already maps buy offers through the shared bidder-owned parser before persisting normalized order terms, so the DB read path should not need raw REST/stream reparsing for standard token-scoped offer display.

## Missing or Weak Fields

These do not block the first SQL pagination pass for token-scoped offers, but they matter for richer display parity.

- `orders.protocol_address` is not first-class. It currently requires `seaport_data_json` parsing.
- `orders.created_at` is DB insertion time, not guaranteed source order creation time. Add `placed_at` or `source_created_at` if UI needs source-accurate placed time from passive `orders`.
- `orders` does not store `scope_label` or `scope_traits_json`. Token scope does not need these; trait/collection bid-book display can derive labels from `source_schema_json`, but direct columns would simplify generic display reads.
- Raw encoded token-set membership is not directly queryable unless decoded or resolved into `token_sets_tokens`.

## Important Invariants

- Pagination must be over token groups, not offer rows.
- Trait filters must be applied before pagination.
- Low-signal token offers must be filtered before token grouping counts are computed.
- Offer counts shown on token cards must exclude hidden/muted offers.
- Token cards should be loaded only for the page's token ids once SQL can produce the page token group.
- `price` and `price_wei` are decimal wei strings and can exceed SQLite integer range. Do not sort by `CAST(price AS INTEGER)`.
- Price ordering in SQL should use a bigint-safe text strategy such as `length(price) DESC, price DESC`, assuming normalized decimal strings have no leading zeroes.
- Bot-snapshot source selection stays unchanged: use snapshot rows only when the collection has enabled bidding jobs, the bidding bot heartbeat is live, and projection freshness is valid.

## Proposed Repository Shape

Add a repository method for collection token-offer pages instead of making the use case own grouping mechanics.

```ts
listCollectionTokenOfferCardsPage(params: {
  chainId: number;
  collectionId: number;
  source: 'orders' | 'bot_snapshot';
  selectedTraits: TraitFilter[];
  selectedTraitRanges: TraitRangeFilter[];
  mediaMode?: string;
  limit: number;
  cursor?: string | null;
}): PersistedTokenOfferCardsPage;
```

The use case should still:

- resolve chain and collection refs
- load facets/customization state
- select the source through existing repository/source policy
- map repository output to API view shapes

The repository adapter should own:

- SQL filtering
- source-specific normalized row selection
- grouping by token
- page cursor decoding/encoding
- token-card row loading for page tokens

## SQL Strategy for `orders`

First-pass query shape:

1. Compute top collection-wide active buy price for the same collection/source:

```sql
SELECT price
FROM orders
WHERE chain_id = @chainId
  AND collection_id = @collectionId
  AND side = 'buy'
  AND source_scope_kind = 'collection'
  AND source_status = 'active'
  AND fillability_status = 'fillable'
  AND price IS NOT NULL
  AND price != ''
  AND (valid_from IS NULL OR valid_from <= @nowSeconds)
  AND (valid_until IS NULL OR valid_until > @nowSeconds)
ORDER BY length(price) DESC, price DESC
LIMIT 1;
```

2. Select token-scoped active buy offers that pass the mute floor:

```sql
WITH token_offers AS (
  SELECT
    id,
    token_id,
    maker,
    price,
    quantity,
    currency,
    valid_until,
    created_at,
    updated_at
  FROM orders
  WHERE chain_id = @chainId
    AND collection_id = @collectionId
    AND side = 'buy'
    AND source_scope_kind = 'token'
    AND token_id IS NOT NULL
    AND source_status = 'active'
    AND fillability_status = 'fillable'
    AND price IS NOT NULL
    AND price != ''
    AND (valid_from IS NULL OR valid_from <= @nowSeconds)
    AND (valid_until IS NULL OR valid_until > @nowSeconds)
)
```

The 10% floor cannot use SQLite integer casts safely for wei strings. Either:

- compare in application after loading candidate rows for the first pass, or
- add a normalized sortable/decimal helper column later, or
- use a custom SQLite scalar function if the project introduces one deliberately.

3. Group by `token_id` and sort groups by top price:

```sql
SELECT
  token_id,
  MAX(length(price)) AS top_price_len,
  MAX(price) AS top_price_text,
  COUNT(*) AS offer_count
FROM token_offers
GROUP BY token_id
ORDER BY top_price_len DESC, top_price_text DESC, token_id ASC
LIMIT @limit OFFSET @offset;
```

This sketch is not final for mixed string lengths: `MAX(price)` must be computed only within the max-length group to avoid lexicographic mistakes. A safer final query should rank offers with `ROW_NUMBER() OVER (PARTITION BY token_id ORDER BY length(price) DESC, price DESC, id ASC)`.

4. Load all offers for page token ids, sorted by price:

```sql
SELECT *
FROM token_offers
WHERE token_id IN (...)
ORDER BY token_id ASC, length(price) DESC, price DESC, id ASC;
```

5. Load token cards only for page token ids.

## Trait Filtering

For token-scoped offer cards, trait filtering applies to the token, not to the offer.

The SQL-backed implementation must join against normalized token traits before page grouping:

- exact trait filters: `token_attributes -> attributes -> attribute_keys`
- range trait filters: reuse the same semantics as token browsing
- `AND` semantics for token scope: same as normal token browsing, not the trait-demand OR search mode

If this is hard to express cleanly in one query, create a reusable SQL trait-filter helper instead of duplicating ad-hoc WHERE/HAVING fragments across token browsing and bidding.

## Bot Snapshot Source

For `bot_snapshot`, the flat normalized rows are already in `trading_bidding_bid_book_rows`.

SQL-backed token grouping can use the same repository method but read from this table instead of `orders`:

- `scope_kind = 'token'`
- `token_id IS NOT NULL`
- `source = 'bot_snapshot'`
- `price_wei` as the unit price
- `quantity`
- `placed_at`, `valid_until`, `seen_at`

Source selection should remain centralized in the repository policy:

- use `bot_snapshot` only when enabled bidding jobs exist for the collection
- require live bidding bot heartbeat
- require fresh projection state
- otherwise fall back to `orders`

## Candidate Indexes

Existing `orders_active_buy_bid_book_lookup_idx` is useful for broad active buy scans but not optimal for token-grouped offer pagination.

Potential future indexes:

```sql
CREATE INDEX IF NOT EXISTS orders_active_token_buy_offer_idx
  ON orders (
    chain_id,
    collection_id,
    source_scope_kind,
    token_id,
    source_status,
    fillability_status,
    valid_from,
    valid_until
  )
  WHERE side = 'buy'
    AND source_scope_kind = 'token'
    AND token_id IS NOT NULL
    AND price IS NOT NULL
    AND price != '';
```

```sql
CREATE INDEX IF NOT EXISTS trading_bidding_bid_book_token_offer_idx
  ON trading_bidding_bid_book_rows (
    chain_id,
    collection_id,
    source,
    scope_kind,
    token_id
  )
  WHERE scope_kind = 'token'
    AND token_id IS NOT NULL;
```

Add price-specific sort helpers only with performance evidence, because wei-string numeric ordering needs care.

## Deferred Implementation Slices

1. Add a DB-layer token-offer page repository contract while leaving current API shape unchanged.
2. Implement `orders` token-scope reads from normalized columns only; remove raw payload parsing from this read path.
3. Push token grouping and page slicing into SQL while keeping the 10% floor in application code if bigint-safe SQL comparison is not ready.
4. Push trait filtering before grouping, reusing token-browser trait filter SQL semantics.
5. Add equivalent `bot_snapshot` SQL grouping from `trading_bidding_bid_book_rows`.
6. Add focused tests for grouped pagination, low-offer hiding, trait-filter-before-pagination, and source parity.
7. Add indexes only after query shape is stable.

## Non-Goals for This Deferred Item

- Do not change bidding bot decision logic.
- Do not make canonical `orders` the bidder's market-operation source.
- Do not change the current UI/API contract unless the repository shape requires it.
- Do not introduce a new materialized `orders` bid-book table unless profiling proves direct normalized `orders` reads are too slow.
