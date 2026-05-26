# Domain Queue Backlog Analysis

This note captures the first inspection pass for a long manual backfill that left the app stopped with NATS still running.

## Snapshot

Captured on 2026-05-25 against local Docker Compose NATS:

```sh
docker compose exec -T natsbox nats --server nats://nats:42720 stream ls
docker compose exec -T natsbox nats --server nats://nats:42720 consumer ls artgod-jobs
docker compose exec -T natsbox nats --server nats://nats:42720 consumer info artgod-jobs orders-update-by-maker-1
```

Observed state:

- `artgod-jobs` held 6,236 messages, all on `artgod.jobs.order-updates-by-maker`.
- `orders-update-by-maker-1` had `Max Ack Pending = 1`, `Outstanding Acks = 1`, and 6,235 unprocessed messages.
- No active interest was attached because the app workers were down.
- Stream live message sequence span was `6462759..6579531`; the stream had many deleted gaps from previously consumed workqueue messages.

## Backlog Shape

The direct-message scan decoded all 6,236 stored messages without consuming them:

```sh
yarn workspace @artgod/indexer run inspect:queue -- --queue order-updates-by-maker --limit 10000
```

Decoded aggregate:

- 6,236 / 6,236 messages were `orders.update-by-maker` on `order-updates-by-maker`.
- 6,236 / 6,236 were `chainId = 1`, `attempt = 0`.
- Scope split:
    - 6,076 global maker invalidation jobs.
    - 160 token-scoped maker invalidation jobs.
- Reason split:
    - 5,590 `global:erc20-balance`.
    - 460 `global:order-counter`.
    - 160 `token:nft-transfer`.
    - 26 `global:approval-change`.
- Block span: `25071435..25173070`.
- Unique blocks: 5,072.
- Unique makers: 298.
- Top maker concentration:
    - `0x1346d9c6315f6c23fe280b49ef215aebd49338b2`: 1,369 messages.
    - `0x255dcfa35b70fc60bfac74ffdfb4782b441a1963`: 632 messages.
    - `0xdae477dd79e44b6952330931b74ee59f7bd91279`: 271 messages.

The current backlog is therefore mostly WETH balance-driven global maker revalidation, not token-level NFT transfer maintenance.

## Source Interpretation

Current code paths that produce these reasons:

- `erc20-balance`: `sync-worker` scans WETH `Transfer` logs when the bidder index is active; `decodeWethMakerInfos()` emits one global maker trigger per indexed `from` or `to` address per log.
- `approval-change`: the same WETH scan emits a global maker trigger for indexed approval owners.
- `order-counter`: Seaport `CounterIncremented` logs decoded by `decodeSeaportOrderEvents()`.
- `nft-transfer`: collection-scoped NFT transfer `from` address emitted by `deriveTokenScopedMakerTriggersFromTransfers()`.

Given the queue shape, likely next design work should focus on reducing or coalescing WETH/global maker revalidation fanout before increasing domain worker concurrency. Raising worker count alone would still perform many repeated maker-level order validations across the same long historical range.

Follow-up policy plan:

- `docs/progress/indexer/21-manual-backfill-order-maintenance-policy.md`
