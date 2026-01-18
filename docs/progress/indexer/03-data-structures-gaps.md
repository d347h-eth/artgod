# Blueprint Gaps: Data Structures and State Capture

This file lists items described in `docs/blueprint/03-data-structures.md` that are not fully implemented yet.

## OnChainData Coverage

The current `OnChainData` only includes:

- `nftTransferEvents`
- `nftBalanceDeltas`

Missing fields from the blueprint accumulator:

- `mintInfos`
- `fillEvents`
- `cancelEvents`
- `bulkCancelEvents`
- `nonceCancelEvents`
- `orderInfos`
- `makerInfos`
- `ftTransferEvents`
- `shards`

## Order and Fill Models

- No `fills` table or persistence logic.
- No logic to update orders to `filled` or to track partial fills.

## Maker Trigger Pattern

- No `makerInfos` generation.
- No `order-updates-by-maker` job pipeline.

## Transfer Uniqueness

- The blueprint mentions `(tx_hash, log_index, batch_index)` for uniqueness.
- The current schema uses `(chain_id, tx_hash, log_index, contract, token_id)` and does not track batch indices for ERC1155 batches.
