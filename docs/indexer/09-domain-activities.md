# Activities Domain

The activities domain builds a simple activity feed derived from transfer events and fills.

Primary file:

- `indexer/src/infra/domain/activities.ts`

Schema:

- `database/migrations/005_activities_schema.sql`

## Inputs

The activities domain consumes `domain.activity.sync` jobs and reads transfer events and fills in the specified block range.

## Logic

For each transfer event row:

- Insert an activity record with:
    - `kind = transfer`
    - `contract`, `token_id`
    - `from_address`, `to_address`
    - `amount`, `block_number`, `tx_hash`, `log_index`

The insert is `INSERT OR IGNORE` against a unique constraint to remain idempotent.

For each fill row:

- Insert an activity record with:
    - `kind = fill`
    - `contract`, `token_id`
    - `from_address` = seller, `to_address` = buyer (derived from `order_side`)
    - `amount`, `block_number`, `tx_hash`, `log_index`

## Current Scope

- Transfer and fill activities are emitted.
- Fill activities depend on the fills table populated by the sync pipeline.
