# Blueprint Gaps: Data Structures and State Capture

This file lists items described in `docs/blueprint/03-data-structures.md` that are not fully implemented yet.

## OnChainData Coverage

The current `OnChainData` includes:

- `nftTransferEvents`
- `nftBalanceDeltas`
- `transactions`
- `fillEvents` (stubbed, no extraction yet)
- `cancelEvents` (stubbed, no extraction yet)
- `orderInfos` (stubbed, no extraction yet)
- `makerInfos` (derived from NFT transfers only)

Still missing from the blueprint accumulator:

- `mintInfos`
- `bulkCancelEvents`
- `nonceCancelEvents`
- `ftTransferEvents`
- `shards`

## Order and Fill Models

- No `fills` table or persistence logic.
- No logic to update orders to `filled` or to track partial fills.

## Maker Trigger Pattern

- Maker triggers exist and are derived from NFT transfers only.
- No ERC20 balance/approval-based maker triggers yet.

## Transfer Uniqueness

- The blueprint mentions `(tx_hash, log_index, batch_index)` for uniqueness.
- The current schema uses `(chain_id, tx_hash, log_index, contract, token_id)` and does not track batch indices for ERC1155 batches.
