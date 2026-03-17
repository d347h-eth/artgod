# Blueprint Gaps: Data Structures and State Capture

This file lists items described in `docs/blueprint/03-data-structures.md` that are not fully implemented yet.

## OnChainData Coverage

The current `OnChainData` includes:

- `transactions`
- `collectionScoped.nftTransferEvents`
- `collectionScoped.nftBalanceDeltas`
- `collectionScoped.fillEvents`
- `collectionScoped.orderInfos`
- `collectionScoped.metadataRefreshEvents`
- `collectionScoped.metadataRefreshRangeEvents`
- `collectionScoped.makerTriggers`
- `global.cancelEvents`
- `global.makerTriggers`

Still missing from the blueprint accumulator:

- `mintInfos`
- `bulkCancelEvents`
- `nonceCancelEvents`
- `ftTransferEvents`
- `shards`

## Order and Fill Models

- `fills` persistence exists.
- Order invalidation/update flows exist for fill/cancel/maker-trigger paths.
- Partial-fill semantics remain limited.

## Maker Trigger Pattern

- Maker triggers are split into token-scoped and global forms.
- NFT transfers and fill-derived item movement produce token-scoped triggers.
- ERC20 balance/approval and Seaport counter invalidations produce global triggers.

## Transfer Uniqueness

- The blueprint mentions `(tx_hash, log_index, batch_index)` for uniqueness.
- The current schema uses `(chain_id, tx_hash, log_index, contract, token_id)` and does not track batch indices for ERC1155 batches.
