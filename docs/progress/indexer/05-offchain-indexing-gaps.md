# Blueprint Gaps: Off-Chain Indexing

This file lists items described in `docs/blueprint/05-offchain-indexing.md` that are not fully implemented yet.

## OpenSea / Seaport Ingestion

- No WebSocket listener for OpenSea Stream.
- No queue for raw OpenSea payloads.
- No Seaport order processor (signature validation, expiry checks, conduit checks).
- No persistence flow for off-chain orders.

## Metadata Pipeline Enhancements

- No explicit mint-triggered metadata jobs (current trigger is transfer-based only).
- No ERC4906 metadata update handling.
- No manual refresh hooks for metadata.
- No normalized `tokens` or `token_attributes` tables (metadata is stored in a single table).
- No collection-level trait recalculation job.

## Focus Mode

- No focus-mode filter gate that discards non-target events after decoding.
- No on-chain ownership fallback when balances are incomplete.
