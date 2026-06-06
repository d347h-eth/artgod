# HTTP JSON-RPC Interaction Catalog

This document maps every source-level HTTP JSON-RPC interaction in the project.
It is organized by workspace, runtime, use case, adapter, endpoint lane, and
resilience coverage.

## Scope

Included:

- HTTP JSON-RPC calls made by backend, indexer, and trading runtime code.
- Developer scripts that make direct HTTP JSON-RPC calls.
- Smoke-test configuration that drives real runtime HTTP JSON-RPC calls.

Excluded:

- generated `build/` output, because it mirrors source files.
- unit-test mocks, because they do not initiate real network calls.
- `RPC_WS_URL` WebSocket calls, because they are a separate protocol lane.
- OpenSea REST, stream, and snapshot API calls, because they are not Ethereum
  HTTP JSON-RPC calls.

Resilience terms in this document are adapter-level terms. Queue job retries,
API fallback behavior, and caller-level retries are called out where relevant,
but they are not counted as JSON-RPC adapter retry or circuit-breaker coverage.

## Configuration Lanes

| Config             | Protocol           | Workspace Use                                             | Selection Model             | Notes                                                                                                                 |
| ------------------ | ------------------ | --------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `RPC_URL`          | HTTP JSON-RPC      | Backend API, indexer primary lanes, trading bidding lanes | Weighted endpoint list      | Shared baseline endpoint pool. Each endpoint has a configured weight, defaulting to `1`.                              |
| `RPC_BACKFILL_URL` | HTTP JSON-RPC      | Indexer sync-worker backfill lane only                    | Weighted endpoint list      | Optional. Backfill sync uses this pool when configured, otherwise it reuses the primary `RPC_URL` provider.           |
| `RPC_WS_URL`       | WebSocket JSON-RPC | Indexer scheduler head listener                           | Weighted failover list      | Not part of this HTTP catalog. The scheduler keeps one active socket and uses other endpoints as failover candidates. |
| `SMOKE_RPC_URL`    | HTTP JSON-RPC      | Indexer smoke tests                                       | Test-provided endpoint list | Feeds the real indexer runtime config under test. Runtime behavior then follows the indexer adapter rows below.       |

Endpoint weighting and dynamic demotion/promotion are implemented by
`shared/config/weighted-endpoints.ts`. That policy changes process-local
effective weights after endpoint success or failure. It is not persistence, a
retry policy, or a circuit breaker by itself.

## Runtime Summary

| Workspace | Runtime / Process                  | Use Case                                                               | Adapter                                             | Config Lane                     | Component Label                                                                      | Adapter Retry | Circuit Breaker | Rate Limit | Current Behavior                                                                                                                                                        |
| --------- | ---------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------ | ------------- | --------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend   | backend API                        | ENS owner resolution                                                   | `backend/src/infra/rpc/viem-backend-rpc.ts`         | `RPC_URL`                       | `backend-rpc`                                                                        | No            | No              | No         | One weighted endpoint attempt per request; failures demote the endpoint and bubble to the API error path.                                                               |
| Backend   | backend API                        | Blockspace and backfill state head/timestamp lookup                    | `backend/src/infra/rpc/viem-backend-rpc.ts`         | `RPC_URL`                       | `backend-rpc`                                                                        | No            | No              | No         | Current block has a short in-memory cache; block timestamps have an in-memory cache. The use case falls back to indexed state or unavailable timestamps when RPC fails. |
| Backend   | backend API                        | Extension activity preview rendering                                   | `backend/src/infra/rpc/viem-backend-rpc.ts`         | `RPC_URL`                       | `backend-rpc`                                                                        | No            | No              | No         | Extension renderers can call `readContract` and `getStorageAt`; failures demote the endpoint and bubble through preview error handling.                                 |
| Backend   | backend API                        | Token URI reads                                                        | `backend/src/infra/rpc/viem-backend-rpc.ts`         | `RPC_URL`                       | `backend-rpc`                                                                        | No            | No              | No         | Extension-owned token URI resolution can call extension contracts; generic ERC721 fallback reads `tokenURI`.                                                            |
| Indexer   | scheduler-worker                   | HTTP head polling                                                      | `indexer/src/infra/rpc/viem.ts`                     | `RPC_URL`                       | `scheduler-http-rpc`                                                                 | Yes           | Yes             | Yes        | Each retry attempt reselects through the weighted pool. Circuit-open, retry, rate-limit, call, and endpoint-attempt events are logged and metered.                      |
| Indexer   | sync-worker realtime consumer      | Realtime block sync                                                    | `indexer/src/infra/rpc/viem.ts`                     | `RPC_URL`                       | `primary-http-rpc`                                                                   | Yes           | Yes             | Yes        | Reads logs, blocks, transactions, and receipts through the primary provider. Worker job retry is separate from adapter retry.                                           |
| Indexer   | sync-worker backfill consumer      | Backfill, gap repair, reorg catch-up, bootstrap catch-up               | `indexer/src/infra/rpc/viem.ts`                     | `RPC_BACKFILL_URL` or `RPC_URL` | `backfill-http-rpc` when a separate pool is configured; otherwise `primary-http-rpc` | Yes           | Yes             | Yes        | Uses the dedicated backfill pool when configured; otherwise shares the primary provider instance.                                                                       |
| Indexer   | bootstrap-worker                   | Collection bootstrap, anchor reads, token enumeration, owner snapshots | `indexer/src/infra/rpc/viem.ts`                     | `RPC_URL`                       | `bootstrap-http-rpc`                                                                 | Yes           | Yes             | Yes        | Reads blocks, current head, total supply, enumerable token ids, and owners through the indexer provider.                                                                |
| Indexer   | bootstrap-worker and domain-worker | On-chain metadata URI resolution                                       | `indexer/src/infra/metadata/viem-token-uri.ts`      | `RPC_URL`                       | `metadata-rpc`                                                                       | No            | No              | No         | Reads ERC721 `tokenURI` and ERC1155 `uri`; resolver returns `null` after a failed read and emits metadata failure metrics.                                              |
| Indexer   | domain-worker                      | Offchain order validation and domain maintenance                       | `indexer/src/infra/rpc/viem.ts`                     | `RPC_URL`                       | `domain-http-rpc`                                                                    | Yes           | Yes             | Yes        | Reads Seaport order status, counters, ownership/approval state, WETH balances/allowance, native ETH balance, and conduit data.                                          |
| Indexer   | reorg-worker                       | Stored block verification and repair scheduling                        | `indexer/src/infra/rpc/viem.ts`                     | `RPC_URL`                       | `reorg-http-rpc`                                                                     | Yes           | Yes             | Yes        | Reads block hashes and current head to detect reorgs and publish recovery backfills.                                                                                    |
| Indexer   | collection-extension-worker        | Extension artifact refresh                                             | `indexer/src/infra/rpc/viem.ts`                     | `RPC_URL`                       | `collection-extension-http-rpc`                                                      | Yes           | Yes             | Yes        | Extension code can read transactions and contracts through the same indexer provider.                                                                                   |
| Trading   | bidding-bot                        | Viem public and wallet clients                                         | `shared/evm/weighted-rpc-transport.ts`              | `RPC_URL`                       | `bidding-viem-rpc`                                                                   | No            | No              | No         | WETH balance reads, allowance reads, approval submission, fee/nonce reads, transaction lookup, and receipt waits use one weighted endpoint attempt per viem request.    |
| Trading   | bidding-bot                        | OpenSea SDK Seaport bridge                                             | `trading/src/runtime/opensea-sdk-rpc-connection.ts` | `RPC_URL`                       | `bidding-opensea-sdk-rpc`                                                            | No            | No              | No         | OpenSea SDK bridge requests are observed and weighted without importing ethers directly. HTTP, invalid JSON, and JSON-RPC errors demote the selected endpoint.          |
| Trading   | sniping-bot                        | No current HTTP JSON-RPC runtime                                       | None                                                | None                            | None                                                                                 | N/A           | N/A             | N/A        | The supervisor can emit a ready lifecycle payload, but the real sniping runtime is not functionally ported.                                                             |

## Backend Details

### ENS Owner Resolution

- Entry point: `backend/src/application/use-cases/owners/resolve-owner-ref.ts`.
- Concrete adapter: `ViemBackendRpcClient.resolveEnsAddress`.
- RPC method path: viem ENS resolution through `getEnsAddress`.
- Resilience: weighted endpoint selection and dynamic endpoint weight drift only.
- Fallback: none. A failed or unresolved ENS lookup reaches the API as an error
  or not-found outcome.

### Blockspace and Backfill State

- Entry point:
  `backend/src/application/use-cases/sync-backfill/get-sync-backfill-state.ts`.
- Concrete adapter methods:
  `getCurrentBlockNumber` and `getBlockTimestamp`.
- RPC method path: current block number and block-by-number timestamp reads.
- Resilience: weighted endpoint selection and dynamic endpoint weight drift only.
- Fallback: the use case catches failures. Head falls back to the highest
  indexed block; missing timestamps are reported as unavailable.
- Local caching: current block number is cached briefly; successful block
  timestamp lookups are cached in memory.

### Extension Rendering and Token URI Reads

- Entry points:
  `backend/src/infra/collections/extension-activity-event-preview.ts`,
  `backend/src/infra/collections/extension-aware-token-uri-read.ts`, and
  backend collection-extension implementations such as Terraforms.
- Concrete adapter methods: `readContract` and `getStorageAt`.
- RPC method path: extension-owned contract reads, renderer reads, storage-slot
  lookup, and generic ERC721 `tokenURI`.
- Resilience: weighted endpoint selection and dynamic endpoint weight drift only.
- Fallback: extension-specific. Generic token URI fallback returns not found
  when the contract read fails.

## Indexer Details

### Shared Indexer HTTP Adapter

`indexer/src/infra/rpc/viem.ts` implements the core indexer `RpcProviderPort`.
It supports:

- `getBlockNumber`
- `getBlock`
- `getLogs`
- `getTransaction`
- `getTransactionReceipt`
- `readContract`
- `getBalance`

It has the strongest HTTP JSON-RPC resilience coverage in the project:

- weighted endpoint selection
- failure-driven effective weight demotion and success-driven recovery
- adapter retry with bounded backoff
- per-endpoint token-bucket rate limiting
- per-endpoint circuit breaker
- structured RPC logs and matching metrics

The policy is configured through `RPC_RETRY_*`, `RPC_RATE_LIMIT_*`, and
`RPC_CIRCUIT_BREAKER_*`.

### Scheduler Worker

- Runtime: `indexer/src/runtime/scheduler-worker.ts`.
- Main use case: polling current head through
  `indexer/src/application/scheduler-worker.ts`.
- HTTP lane: `scheduler-http-rpc`.
- Resilience: full indexer HTTP adapter coverage.
- Adjacent non-HTTP lane: optional `RPC_WS_URL` WebSocket head source. HTTP
  polling remains the authoritative recovery path for missed socket heads.

### Sync Worker

- Runtime: `indexer/src/runtime/sync-worker.ts`.
- Main use cases: realtime sync, backfill sync, gap repair, reorg recovery, and
  bootstrap catch-up.
- HTTP lanes:
    - `primary-http-rpc` for realtime work from `RPC_URL`.
    - `backfill-http-rpc` for backfill work from `RPC_BACKFILL_URL` when set.
    - `primary-http-rpc` for backfill work when `RPC_BACKFILL_URL` is not set.
- RPC method paths:
    - logs for transfers, approvals, metadata refreshes, Seaport, WETH, and
      collection-extension watch specs
    - blocks for range context
    - transactions and receipts for fill decoding
- Resilience: full indexer HTTP adapter coverage.

### Bootstrap Worker

- Runtime: `indexer/src/runtime/bootstrap-worker.ts`.
- Main use cases: collection bootstrap, anchor-block reads, metadata task
  seeding, token enumeration, and ownership snapshots.
- HTTP lane: `bootstrap-http-rpc`.
- RPC method paths: block reads, current head reads, `totalSupply`,
  enumerable token ids, and owner reads.
- Resilience: full indexer HTTP adapter coverage for the main bootstrap RPC
  provider.
- Separate metadata lane: metadata URI resolution uses `metadata-rpc`, covered
  below.

### Metadata URI Resolution

- Runtimes: `bootstrap-worker` and `domain-worker`.
- Adapter: `indexer/src/infra/metadata/viem-token-uri.ts`.
- HTTP lane: `metadata-rpc`.
- RPC method paths: ERC721 `tokenURI` and ERC1155 `uri`.
- Resilience: weighted endpoint selection and dynamic endpoint weight drift only.
- Fallback: the resolver records metadata failure metrics and returns `null`.
- Audit note: this is an intentional fail-soft path today, but it does not have
  the retry/circuit/rate-limit guarantees of `ViemRpcProvider`.

### Domain Worker

- Runtime: `indexer/src/runtime/domain-worker.ts`.
- Main use cases: order domain sync, order update by maker/id, order upsert,
  metadata refresh, metadata stats, activity projection, and offchain order
  validation.
- HTTP lane: `domain-http-rpc`.
- RPC method paths: Seaport order status, Seaport counters, conduit state,
  ownership, approvals, WETH allowance/balance, native ETH balance, and
  extension reads.
- Resilience: full indexer HTTP adapter coverage.

### Reorg Worker

- Runtime: `indexer/src/runtime/reorg-worker.ts`.
- Main use case: compare locally stored block hashes against RPC block hashes
  and schedule recovery work when they diverge.
- HTTP lane: `reorg-http-rpc`.
- RPC method paths: block reads and current head reads.
- Resilience: full indexer HTTP adapter coverage.

### Collection Extension Worker

- Runtime: `indexer/src/runtime/collection-extension-worker.ts`.
- Main use case: extension artifact refresh.
- HTTP lane: `collection-extension-http-rpc`.
- RPC method paths: extension-owned transaction and contract reads.
- Resilience: full indexer HTTP adapter coverage.

## Trading Details

### Bidding Viem Lane

- Runtime: `trading/src/runtime/bidding-runtime.ts`.
- Adapter: `shared/evm/weighted-rpc-transport.ts`.
- HTTP lane: `bidding-viem-rpc`.
- Config: `RPC_URL`.
- RPC method paths:
    - WETH `balanceOf` for maker balance checks.
    - WETH `allowance` during startup allowance bootstrap.
    - WETH `approve` when allowance must be submitted.
    - fee, nonce, transaction lookup, and receipt-wait calls used by the allowance
      flow and viem wallet/public clients.
- Resilience: weighted endpoint selection and dynamic endpoint weight drift only.
- Audit note: this lane has no adapter retry, circuit breaker, or JSON-RPC rate
  limiter. The allowance service has detailed logs around individual actions,
  but those logs do not add transport resilience.

### OpenSea SDK Seaport Bridge Lane

- Runtime: `trading/src/runtime/bidding-runtime.ts`.
- Adapter: `trading/src/runtime/opensea-sdk-rpc-connection.ts`.
- HTTP lane: `bidding-opensea-sdk-rpc`.
- Config: `RPC_URL`.
- RPC method paths: Ethereum JSON-RPC requests made by the OpenSea SDK bridge
  during offer creation, collection-offer creation, and offchain cancellation.
- Resilience: weighted endpoint selection and dynamic endpoint weight drift only.
- Audit note: OpenSea REST discovery/recovery calls have their own retry and
  rate limiter, and cancellation is retried at the OpenSea service layer.
  Placement uses the OpenSea service rate limiter. None of that is JSON-RPC
  transport resilience for this lane.

## Developer Scripts and Tests

| Path                                                      | Use Case                                                             | Endpoint Source                          | Weighted Selection      | Adapter Retry           | Circuit Breaker         | Rate Limit              | Notes                                                                                     |
| --------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------- | ----------------------- | ----------------------- | ----------------------- | ----------------------- | ----------------------------------------------------------------------------------------- |
| `scripts/dump-tx.js`                                      | Dump transaction, receipt, and block data                            | `--rpc` or first endpoint from `RPC_URL` | No                      | No                      | No                      | No                      | Uses a direct viem HTTP client for manual diagnostics.                                    |
| `scripts/debug/ethereum-node-probe.mjs`                   | Probe node health, account state, txpool, and optional self-transfer | `--rpc` or first endpoint from `RPC_URL` | No                      | No                      | No                      | No                      | Uses direct viem HTTP clients and optional wallet client.                                 |
| `scripts/benchmark-contract-read/fetch-terraform-data.ts` | Benchmark Terraforms contract reads                                  | Fixed local benchmark URL                | No                      | No                      | No                      | No                      | Uses raw JSON-RPC batch fetches for benchmarking only.                                    |
| `indexer/tests/smoke.test.ts`                             | End-to-end indexer smoke tests                                       | `SMOKE_RPC_URL`                          | Follows runtime adapter | Follows runtime adapter | Follows runtime adapter | Follows runtime adapter | The test config feeds actual indexer workers, so coverage follows the indexer rows above. |

## Non-Callers

These areas configure or validate RPC settings but do not initiate HTTP
JSON-RPC requests themselves:

- Frontend/Admin UI configuration surfaces.
- Desktop Rust runtime config validation and process env composition.
- Shared config parsers and generated setting defaults.
- Docs and OpenAPI definitions.

## Retry and Circuit-Breaker Audit

Covered today:

- All indexer runtime lanes that use `ViemRpcProvider` have adapter retry,
  per-endpoint rate limiting, per-endpoint circuit breaker, weighted endpoint
  selection, structured logs, and metrics.

Partially covered today:

- Backend `ViemBackendRpcClient` has weighted endpoint selection, dynamic weight
  drift, observability, and local caches for selected reads. It does not have
  adapter retry, circuit breaker, or rate limiting.
- Indexer `ViemTokenUriResolver` has weighted endpoint selection, dynamic weight
  drift, observability, and metadata failure metrics. It does not have adapter
  retry, circuit breaker, or rate limiting.
- Trading `createWeightedRpcTransport` has weighted endpoint selection, dynamic
  weight drift, and observability. It does not have adapter retry, circuit
  breaker, or rate limiting.
- Trading `createOpenSeaSdkRpcConnection` has weighted endpoint selection,
  dynamic weight drift, and observability. It does not have adapter retry,
  circuit breaker, or rate limiting.

Not covered:

- Developer scripts use direct HTTP JSON-RPC clients or fetches with no runtime
  observability, retry, circuit breaker, or rate limiter.
- OpenSea REST retries and rate limiting do not cover Ethereum HTTP JSON-RPC
  calls. They are separate integration resilience.

## Recommended Follow-Up

The clean next step is to extract a shared HTTP JSON-RPC resilience layer that
can be reused by backend, indexer metadata, and trading without copying the
indexer provider internals. That layer should compose:

- weighted endpoint selector
- retry policy
- circuit breaker
- optional token-bucket rate limiter
- existing shared RPC observability

Then each workspace can keep its own adapter boundary and method vocabulary
while sharing the transport resilience policy.
