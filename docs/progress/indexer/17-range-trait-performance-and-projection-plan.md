# Range Trait Performance And Numeric Projection (Deferred)

## Scope

This document captures deferred follow-up work for collection trait range filtering after the first production optimization pass.

Current implemented state:

- range trait filters are user/configuration-driven at collection level
- range filtering still uses normalized trait tables as the source of truth
- the first optimization pass rewrites token-browser range filtering from correlated per-token `EXISTS` checks into set-based token-id prefilters

That first pass reduces the immediate cost of `show all` token browsing, but it does not change the underlying storage model.

## Why More Work Is Still Needed

Range filtering remains dependent on normalized string-valued trait storage:

- `attribute_keys`
- `attributes`
- `token_attributes`

For range traits, the backend still needs numeric parsing/casting logic over string values at read time. That is acceptable for the current feature slice, but it has limits:

- large collections still pay non-trivial read cost for range scans
- numeric semantics remain read-time logic instead of materialized/query-native state
- min/max bounds and range filtering work from the same normalized tables, so they do not get a dedicated numeric access path

## Deferred Direction

Introduce a dedicated numeric trait projection table for traits that are explicitly configured as `range`.

Proposed shape:

- one row per `chain_id + collection_id + trait key + token_id`
- one parsed numeric value column
- indexes optimized for:
  - `collection + trait key + numeric value`
  - `collection + trait key + token_id`

Representative example:

```sql
token_numeric_attributes (
  chain_id,
  collection_id,
  attribute_key_id,
  token_id,
  numeric_value
)
```

This table would remain a derived/materialized projection. The normalized trait tables stay canonical.

## Configuration Semantics

Numeric projection should not be built for every parseable numeric-looking attribute.

Instead, it should be driven by explicit collection semantics:

- user-defined trait presentation config
- extension-defined override config

Only trait keys whose effective presentation kind is `range` should be materialized into the numeric projection.

This avoids:

- heuristic over-indexing
- wasted storage for irrelevant keys
- prematurely freezing numeric meaning for traits that are still only categorical in product semantics

## Late Flip To Range

The important deferred case is a collection that is already live and then receives a late configuration change:

- user changes a trait from `set` to `range`
- or an extension override activates a range trait after install/change

That transition should trigger a targeted rebuild for:

- one collection
- one trait key

It should not require:

- full collection reprojection
- full metadata rebootstrap
- global trait reprojection

Expected flow:

1. effective trait presentation changes to `range`
2. backend/customization flow records the new config
3. indexer receives a targeted projection rebuild request for that collection + trait key
4. numeric rows for that collection + trait key are rebuilt from canonical normalized trait rows
5. range queries/min-max hints start using the numeric projection once rebuild completes

## Ongoing Maintenance After Projection Exists

Once a trait key is materialized as `range`, metadata updates for affected tokens should keep the numeric projection in sync incrementally.

That means token metadata/attribute refresh should also:

1. detect whether the collection currently has any materialized range keys
2. for affected token + key rows, delete old numeric projection rows
3. insert fresh numeric projection rows for values that satisfy the current numeric parsing policy

## Parsing Policy

Current agreed first-pass numeric semantics:

- unsigned integers only
- non-numeric values ignored

That policy should stay explicit and local to the numeric projection implementation.

If parsing rules later expand to signed integers or decimals, the projection rebuild path must support recomputing existing materialized keys deterministically.

## Suggested Rollout

1. keep the current set-based query rewrite in place
2. add the numeric projection table + indexes
3. add targeted rebuild jobs for `late flip to range`
4. switch range filtering/min-max reads to the projection table
5. keep normalized trait tables as canonical truth

## Non-Goals

This deferred plan does not change:

- discrete/set trait filtering
- trait template rendering for token cards
- trait template rendering for activity rows
- collection extension media modes
