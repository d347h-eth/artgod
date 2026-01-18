# Activities Domain

The activities domain builds a simple activity feed derived from transfer events.

Primary file:

- `indexer/src/infra/domain/activities.ts`

Schema:

- `database/migrations/005_activities_schema.sql`

## Inputs

The activities domain consumes `domain.activity.sync` jobs and reads transfer events in the specified block range.

## Logic

For each transfer event row:

- Insert an activity record with:
  - `kind = transfer`
  - `contract`, `token_id`
  - `from_address`, `to_address`
  - `amount`, `block_number`, `tx_hash`, `log_index`

The insert is `INSERT OR IGNORE` against a unique constraint to remain idempotent.

## Current Scope

- Only transfer activities are emitted.
- Fill activities are defined in the domain types but not yet produced.
