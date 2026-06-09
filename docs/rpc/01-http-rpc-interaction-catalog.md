# HTTP JSON-RPC Interaction Catalog

This document maps every source-level HTTP JSON-RPC interaction in the project.
It is organized by workspace, runtime, use case, adapter, endpoint lane, and
resilience coverage.

## Scope

Included:

- HTTP JSON-RPC calls made by backend, indexer, and trading runtime code.
- Desktop Admin configuration-time HTTP JSON-RPC probes used for automated
  endpoint sourcing and pre-start sanity checks.
- Developer scripts that make direct HTTP JSON-RPC calls.
- Smoke-test configuration that drives real runtime HTTP JSON-RPC calls.

Excluded:

- generated `build/` output, because it mirrors source files.
- unit-test mocks, because they do not initiate real network calls.
- `RPC_WS_URL_LIST` WebSocket calls, because they are a separate protocol lane.
- OpenSea REST, stream, and snapshot API calls, because they are not Ethereum
  HTTP JSON-RPC calls.

Resilience terms in this document are adapter-level terms. Queue job retries,
API fallback behavior, and caller-level retries are called out where relevant,
but they are not counted as JSON-RPC adapter retry or circuit-breaker coverage.

## Configuration Lanes

| Config                  | Protocol           | Workspace Use                                             | Selection Model             | Notes                                                                                                                 |
| ----------------------- | ------------------ | --------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `RPC_URL_LIST`          | HTTP JSON-RPC      | Backend API, indexer primary lanes, trading bidding lanes | Weighted endpoint list      | Shared baseline endpoint pool. Each endpoint has a configured weight, defaulting to `1`.                              |
| `RPC_BACKFILL_URL_LIST` | HTTP JSON-RPC      | Indexer sync-worker backfill lane only                    | Weighted endpoint list      | Optional. Backfill sync uses this pool when configured, otherwise it reuses the primary `RPC_URL_LIST` provider.      |
| `RPC_WS_URL_LIST`       | WebSocket JSON-RPC | Indexer scheduler head listener                           | Weighted failover list      | Not part of this HTTP catalog. The scheduler keeps one active socket and uses other endpoints as failover candidates. |
| `SMOKE_RPC_URL_LIST`    | HTTP JSON-RPC      | Indexer smoke tests                                       | Test-provided endpoint list | Feeds the real indexer runtime config under test. Runtime behavior then follows the indexer adapter rows below.       |

Endpoint weighting and dynamic demotion/promotion are implemented by
`shared/config/weighted-endpoints.ts`. That policy changes process-local
effective weights after endpoint success or failure. It is not persistence, a
retry policy, or a circuit breaker by itself.

HTTP JSON-RPC endpoint execution and matching observability are centralized in
`shared/evm/rpc-execution.ts`. Backend, indexer, metadata, trading viem, and
OpenSea SDK bridge lanes use that shared harness for endpoint attempt lifecycle,
call outcome metrics, endpoint weight updates, retry scheduling, rate-limit
waits, and circuit-open events. Adapter-local code owns only the RPC operation,
domain mapping, and any integration-specific wrappers such as APM spans.

## Runtime Summary

| Workspace | Runtime / Process                  | Use Case                                                               | Adapter                                             | Config Lane                               | Component Label                                                                      | Adapter Retry | Circuit Breaker | Rate Limit | Current Behavior                                                                                                                                                         |
| --------- | ---------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------ | ------------- | --------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Backend   | backend API                        | ENS owner resolution                                                   | `backend/src/infra/rpc/viem-backend-rpc.ts`         | `RPC_URL_LIST`                            | `backend-rpc`                                                                        | Yes           | Yes             | Yes        | Each retry attempt reselects through the weighted pool. Endpoint attempts, retry scheduling, circuit-open, rate-limit, and call outcomes are logged and metered.         |
| Backend   | backend API                        | Blockspace and backfill state head/timestamp lookup                    | `backend/src/infra/rpc/viem-backend-rpc.ts`         | `RPC_URL_LIST`                            | `backend-rpc`                                                                        | Yes           | Yes             | Yes        | Current block has a short in-memory cache; block timestamps have an in-memory cache. The use case falls back to indexed state or unavailable timestamps after RPC fails. |
| Backend   | backend API                        | Extension activity preview rendering                                   | `backend/src/infra/rpc/viem-backend-rpc.ts`         | `RPC_URL_LIST`                            | `backend-rpc`                                                                        | Yes           | Yes             | Yes        | Extension renderers can call `readContract` and `getStorageAt`; transient failures demote endpoints and retry before bubbling through preview error handling. Deterministic contract failures surface immediately. |
| Backend   | backend API                        | Token URI reads                                                        | `backend/src/infra/rpc/viem-backend-rpc.ts`         | `RPC_URL_LIST`                            | `backend-rpc`                                                                        | Yes           | Yes             | Yes        | Extension-owned token URI resolution can call extension contracts; generic ERC721 fallback reads `tokenURI` through the resilient backend RPC client. Deterministic contract failures surface immediately. |
| Backend   | backend API                        | Bootstrap contract probe                                               | `backend/src/infra/bootstrap/viem-bootstrap-contract-probe.ts` | `RPC_URL_LIST`                            | `backend-rpc`                                                                        | Yes           | Yes             | Yes        | Pre-bootstrap ERC721 probing reads ERC165 support, collection name, supply, first token, token URI, and owner fallback through the resilient backend RPC client. Missing methods and reverts are deterministic contract failures, so they do not exhaust retries. Token URI payload and image-size fetches are ordinary HTTP/media fetches, not JSON-RPC. |
| Indexer   | scheduler-worker                   | HTTP head polling                                                      | `indexer/src/infra/rpc/viem.ts`                     | `RPC_URL_LIST`                            | `scheduler-http-rpc`                                                                 | Yes           | Yes             | Yes        | Each retry attempt reselects through the weighted pool. Circuit-open, retry, rate-limit, call, and endpoint-attempt events are logged and metered.                       |
| Indexer   | sync-worker realtime consumer      | Realtime block sync                                                    | `indexer/src/infra/rpc/viem.ts`                     | `RPC_URL_LIST`                            | `primary-http-rpc`                                                                   | Yes           | Yes             | Yes        | Reads logs, blocks, transactions, and receipts through the primary provider. Worker job retry is separate from adapter retry.                                            |
| Indexer   | sync-worker backfill consumer      | Backfill, gap repair, reorg catch-up, bootstrap catch-up               | `indexer/src/infra/rpc/viem.ts`                     | `RPC_BACKFILL_URL_LIST` or `RPC_URL_LIST` | `backfill-http-rpc` when a separate pool is configured; otherwise `primary-http-rpc` | Yes           | Yes             | Yes        | Uses the dedicated backfill pool when configured; otherwise shares the primary provider instance.                                                                        |
| Indexer   | bootstrap-worker                   | Collection bootstrap, anchor reads, token enumeration, owner snapshots | `indexer/src/infra/rpc/viem.ts`                     | `RPC_URL_LIST`                            | `bootstrap-http-rpc`                                                                 | Yes           | Yes             | Yes        | Reads blocks, current head, total supply, enumerable token ids, and owners through the indexer provider.                                                                 |
| Indexer   | bootstrap-worker and domain-worker | On-chain metadata URI resolution                                       | `indexer/src/infra/metadata/viem-token-uri.ts`      | `RPC_URL_LIST`                            | `metadata-rpc`                                                                       | Yes           | Yes             | Yes        | Reads ERC721 `tokenURI` and ERC1155 `uri`; transient endpoint failures retry through the weighted pool before the resolver returns `null`.                               |
| Indexer   | domain-worker                      | Offchain order validation and domain maintenance                       | `indexer/src/infra/rpc/viem.ts`                     | `RPC_URL_LIST`                            | `domain-http-rpc`                                                                    | Yes           | Yes             | Yes        | Reads Seaport order status, counters, ownership/approval state, WETH balances/allowance, native ETH balance, and conduit data.                                           |
| Indexer   | reorg-worker                       | Stored block verification and repair scheduling                        | `indexer/src/infra/rpc/viem.ts`                     | `RPC_URL_LIST`                            | `reorg-http-rpc`                                                                     | Yes           | Yes             | Yes        | Reads block hashes and current head to detect reorgs and publish recovery backfills.                                                                                     |
| Indexer   | collection-extension-worker        | Extension artifact refresh                                             | `indexer/src/infra/rpc/viem.ts`                     | `RPC_URL_LIST`                            | `collection-extension-http-rpc`                                                      | Yes           | Yes             | Yes        | Extension code can read transactions and contracts through the same indexer provider.                                                                                    |
| Trading   | bidding-bot                        | Viem read-only public client                                           | `shared/evm/weighted-rpc-transport.ts`              | `RPC_URL_LIST`                            | `bidding-read-only-viem-rpc`                                                         | Yes           | Yes             | Yes        | WETH balance reads, allowance reads, fee simulation, transaction lookup, and receipt waits retry through the weighted pool with shared per-endpoint resilience.          |
| Trading   | bidding-bot                        | Viem write-capable wallet client                                       | `shared/evm/weighted-rpc-transport.ts`              | `RPC_URL_LIST`                            | `bidding-write-capable-viem-rpc`                                                     | No            | No              | No         | Startup WETH approval submission uses one weighted endpoint attempt per viem request. Viem internal transport retries are disabled for this lane.                        |
| Trading   | bidding-bot                        | OpenSea SDK Seaport bridge                                             | `trading/src/runtime/opensea-sdk-rpc-connection.ts` | `RPC_URL_LIST`                            | `bidding-opensea-sdk-rpc`                                                            | No            | No              | No         | OpenSea SDK bridge requests are observed and weighted without importing ethers directly. HTTP, invalid JSON, and JSON-RPC errors demote the selected endpoint.           |
| Trading   | sniping-bot                        | No current HTTP JSON-RPC runtime                                       | None                                                | None                                      | None                                                                                 | N/A           | N/A             | N/A        | The supervisor can emit a ready lifecycle payload, but the real sniping runtime is not functionally ported.                                                              |

## Backend Details

### ENS Owner Resolution

- Entry point: `backend/src/application/use-cases/owners/resolve-owner-ref.ts`.
- Concrete adapter: `ViemBackendRpcClient.resolveEnsAddress`.
- RPC method path: viem ENS resolution through `getEnsAddress`.
- Resilience: weighted endpoint selection, dynamic endpoint weight drift,
  adapter retry, per-endpoint rate limiting, and per-endpoint circuit breaker.
- Fallback: none. A failed or unresolved ENS lookup reaches the API as an error
  or not-found outcome after retry exhaustion.

### Blockspace and Backfill State

- Entry point:
  `backend/src/application/use-cases/sync-backfill/get-sync-backfill-state.ts`.
- Concrete adapter methods:
  `getCurrentBlockNumber` and `getBlockTimestamp`.
- RPC method path: current block number and block-by-number timestamp reads.
- Resilience: weighted endpoint selection, dynamic endpoint weight drift,
  adapter retry, per-endpoint rate limiting, and per-endpoint circuit breaker.
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
- Resilience: weighted endpoint selection, dynamic endpoint weight drift,
  adapter retry, per-endpoint rate limiting, and per-endpoint circuit breaker.
  Deterministic contract-call failures such as missing methods, zero returned
  data, and EVM reverts are not retried and do not penalize the selected
  endpoint.
- Fallback: extension-specific. Generic token URI fallback returns not found
  when the contract read still fails after retry exhaustion or deterministic
  contract failure.

### Bootstrap Contract Probe

- Entry point:
  `backend/src/application/use-cases/bootstrap/probe-collection-contract.ts`
  behind `GET /api/:chain_ref/collections/bootstrap/probe`.
- Concrete adapter:
  `backend/src/infra/bootstrap/viem-bootstrap-contract-probe.ts`.
- Concrete RPC adapter method: `ViemBackendRpcClient.readContract`.
- RPC method path: ERC165 `supportsInterface`, ERC721 Metadata `name` and
  `tokenURI`, ERC721 `totalSupply`, ERC721Enumerable `tokenByIndex`, and
  ERC721 `ownerOf` fallback checks.
- Resilience: inherited from `backend-rpc`, including weighted endpoint
  selection, dynamic endpoint weight drift, adapter retry, per-endpoint rate
  limiting, and per-endpoint circuit breaker. Missing ERC165/enumerable
  methods, zero returned data, and EVM reverts short-circuit as deterministic
  contract-call failures instead of exhausting retry attempts.
- Non-JSON-RPC follow-up: after `tokenURI` resolves, metadata payload fetches
  and token image size probes use HTTP/media fetches through the configured IPFS
  gateway origin when needed.
- Fallback: failed reads are normalized into probe warnings and nullable probe
  fields so the user can choose manual bootstrap inputs when automatic probing
  is incomplete.

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

The policy is configured through `RPC_HTTP_REQUEST_TIMEOUT_MS`, `RPC_RETRY_*`,
`RPC_RATE_LIMIT_*`, and `RPC_CIRCUIT_BREAKER_*`. The timeout is per HTTP
request attempt; the retry policy still bounds the total number of attempts.

### Scheduler Worker

- Runtime: `indexer/src/runtime/scheduler-worker.ts`.
- Main use case: polling current head through
  `indexer/src/application/scheduler-worker.ts`.
- HTTP lane: `scheduler-http-rpc`.
- Resilience: full indexer HTTP adapter coverage.
- Adjacent non-HTTP lane: optional `RPC_WS_URL_LIST` WebSocket head source. HTTP
  polling remains the authoritative recovery path for missed socket heads.

### Sync Worker

- Runtime: `indexer/src/runtime/sync-worker.ts`.
- Main use cases: realtime sync, backfill sync, gap repair, reorg recovery, and
  bootstrap catch-up.
- HTTP lanes:
    - `primary-http-rpc` for realtime work from `RPC_URL_LIST`.
    - `backfill-http-rpc` for backfill work from `RPC_BACKFILL_URL_LIST` when set.
    - `primary-http-rpc` for backfill work when `RPC_BACKFILL_URL_LIST` is not set.
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
- Resilience: weighted endpoint selection, dynamic endpoint weight drift,
  adapter retry, per-endpoint rate limiting, and per-endpoint circuit breaker.
- Fallback: the resolver records metadata failure metrics and returns `null`
  after retry exhaustion.

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

### Bidding Read-Only Viem Lane

- Runtime: `trading/src/runtime/bidding-runtime.ts`.
- Adapter: `shared/evm/weighted-rpc-transport.ts`.
- HTTP lane: `bidding-read-only-viem-rpc`.
- Config: `RPC_URL_LIST`.
- RPC method paths:
    - WETH `balanceOf` for maker balance checks.
    - WETH `allowance` during startup allowance bootstrap.
    - fee simulation, transaction lookup, and receipt-wait calls used by the
      allowance flow and viem public client.
- Resilience: weighted endpoint selection, dynamic endpoint weight drift,
  adapter retry, per-endpoint rate limiting, and per-endpoint circuit breaker.
- Safety boundary: state-changing JSON-RPC methods are rejected before endpoint
  selection so write submissions cannot accidentally run through the retrying
  read-only lane.

### Bidding Write-Capable Viem Lane

- Runtime: `trading/src/runtime/bidding-runtime.ts`.
- Adapter: `shared/evm/weighted-rpc-transport.ts`.
- HTTP lane: `bidding-write-capable-viem-rpc`.
- Config: `RPC_URL_LIST`.
- RPC method paths:
    - WETH `approve` submission when startup allowance must be increased.
- Resilience: weighted endpoint selection and dynamic endpoint weight drift only.
- Safety boundary: viem internal transport retries are disabled. Retry policy for
  transaction writes remains owned by explicit transaction orchestration, not the
  generic JSON-RPC transport.

### OpenSea SDK Seaport Bridge Lane

- Runtime: `trading/src/runtime/bidding-runtime.ts`.
- Adapter: `trading/src/runtime/opensea-sdk-rpc-connection.ts`.
- HTTP lane: `bidding-opensea-sdk-rpc`.
- Config: `RPC_URL_LIST`.
- RPC method paths: Ethereum JSON-RPC requests made by the OpenSea SDK bridge
  during offer creation, collection-offer creation, and offchain cancellation.
- Resilience: weighted endpoint selection and dynamic endpoint weight drift only.
- Audit note: OpenSea REST discovery/recovery calls have their own retry and
  rate limiter, and cancellation is retried at the OpenSea service layer.
  Placement uses the OpenSea service rate limiter. None of that is JSON-RPC
  transport resilience for this lane.

## Developer Scripts and Tests

| Path                                                      | Use Case                                                             | Endpoint Source                                                  | Weighted Selection                   | Adapter Retry           | Circuit Breaker         | Rate Limit              | Notes                                                                                                                                                                                                           |
| --------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------ | ----------------------- | ----------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src-tauri/src/runtime/rpc_auto_sourcing.rs`              | Admin automated public RPC sourcing and pre-start sanity checks      | Embedded/saved/fresh Chainlist payload or current `RPC_URL_LIST` | Initial latency-derived weights only | No                      | No                      | No                      | Runs before runtime startup from the desktop Admin plane; successful Chainlist sourcing writes a curated `RPC_URL_LIST` config value, while configured-list sanity checks do not replace the user endpoint set. |
| `scripts/dump-tx.js`                                      | Dump transaction, receipt, and block data                            | `--rpc` or first endpoint from `RPC_URL_LIST`                    | No                                   | No                      | No                      | No                      | Uses a direct viem HTTP client for manual diagnostics.                                                                                                                                                          |
| `scripts/debug/ethereum-node-probe.mjs`                   | Probe node health, account state, txpool, and optional self-transfer | `--rpc` or first endpoint from `RPC_URL_LIST`                    | No                                   | No                      | No                      | No                      | Uses direct viem HTTP clients and optional wallet client.                                                                                                                                                       |
| `scripts/benchmark-contract-read/fetch-terraform-data.ts` | Benchmark Terraforms contract reads                                  | Fixed local benchmark URL                                        | No                                   | No                      | No                      | No                      | Uses raw JSON-RPC batch fetches for benchmarking only.                                                                                                                                                          |
| `indexer/tests/smoke.test.ts`                             | End-to-end indexer smoke tests                                       | `SMOKE_RPC_URL_LIST`                                             | Follows runtime adapter              | Follows runtime adapter | Follows runtime adapter | Follows runtime adapter | The test config feeds actual indexer workers, so coverage follows the indexer rows above.                                                                                                                       |

## Non-Callers

These areas configure or validate RPC settings but do not initiate HTTP
JSON-RPC requests themselves:

- Frontend/Admin UI configuration surfaces.
- Desktop Rust runtime config validation and process env composition outside
  the Admin RPC auto-sourcing benchmark command listed above.
- Shared config parsers and generated setting defaults.
- Docs and OpenAPI definitions.

## Retry and Circuit-Breaker Audit

Covered today:

- All indexer runtime lanes that use `ViemRpcProvider` have adapter retry,
  per-endpoint rate limiting, per-endpoint circuit breaker, weighted endpoint
  selection, structured logs, and metrics.
- Backend `ViemBackendRpcClient` has adapter retry, per-endpoint rate limiting,
  per-endpoint circuit breaker, weighted endpoint selection, structured logs,
  metrics, and local caches for selected reads.
- Indexer `ViemTokenUriResolver` has adapter retry, per-endpoint rate limiting,
  per-endpoint circuit breaker, weighted endpoint selection, structured logs,
  metrics, and metadata failure metrics.

Partially covered today:

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

The remaining trading runtime gaps are the write-capable viem lane and the
OpenSea SDK bridge. Do not put blind retry around write/broadcast paths such as
approval submission. The existing resilient transport is scoped to methods that
can safely use shared retry, rate-limit, and circuit-breaker policy:

- write/broadcast calls need idempotency-aware handling before retry is safe.
- the OpenSea SDK bridge needs the same read/write classification before it can
  share the retry layer.
