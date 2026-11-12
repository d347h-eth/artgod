# 111K Mainnet Bootstrap Contract

The embedded `111k` extension bootstraps the deployed Ethereum mainnet collection
without walking every possible token ID. It tracks the entire contract so
future artwork, container and receipt mints use ordinary transfer sync.
[`BKL-073`](../planning/01-unified-backlog.md) owns status; the
[extension-system reference](01-collection-extensions.md#bundled-extension-111k)
describes the generic integration.

## Deployment identity

The definition in [`shared/extensions/111k.ts`](../../shared/extensions/111k.ts)
is the sole owner of the supported deployment's chain, address and lower bound.
Mainnet deployment and verified source were checked on **2026-11-11**.

| Property              | Value                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| Extension key         | `111k`, exported as `NFT111K_EXTENSION_KEY`.                                                          |
| Chain                 | Ethereum mainnet, chain ID `1`.                                                                       |
| Contract              | `0x08cDed8258730bda384FF198001E47a1B50f7f9d`.                                                         |
| Deployment block      | `26387160`, inclusive when reading mint logs.                                                         |
| Creation transaction  | `0x6c949b4b008f78993438a8b46205111609b0a8c4ea0d29d4ef547ecc2e0f95d9`.                                 |
| Verified source       | [NFT111K on Etherscan](https://etherscan.io/address/0x08cDed8258730bda384FF198001E47a1B50f7f9d#code). |
| Batch ownership limit | `150` IDs per `getTokenInfos` call.                                                                   |
| Scope                 | Existing `contract_all_tokens`, with null range bounds and no explicit ID list.                       |

The creation receipt confirms this address and deployment block. The verified
constructor does not mint, and the mint paths use ordinary ERC721 Transfer
events through ERC721A. The deployed contract reports ERC721 support and no
ERC721Enumerable support. The narrow inventory read contract is:

```ts
parseAbi([
    "function totalSupply() view returns (uint256)",
    "function getTokenInfos(uint256[] tokenIds) view returns ((uint8 kind, uint256 displayId, address holder)[] infos)",
]);
```

`getTokenInfos` returns None/zero display ID/zero holder for absent IDs. A valid
nonzero kind and holder indicates presence. The extension does not need `stats`,
allocation counters or token-family cap expansion.

Identity matching is exact after address normalization. There is no broad name
match, extra chain catalog row, prepared collection, new queue or migration.
Manual range/list requests do not install this full-contract extension.

## Scope and preserved boundaries

The existing **Entire contract** choice retains `{ "mode": "enumerable" }` on
the wire. For this installed extension, its optional hook supplies inventory
instead of `tokenByIndex`; this does not assert ERC721Enumerable support.

The initial present inventory and the ongoing tracking universe remain separate.
For example, a circulating supply of 3,498 does not define token IDs `1..3498`.
High-ID containers and receipts must remain admitted after the snapshot. No
present-ID array is written back as a range or explicit tracking list.

The original bounded implementation decisions still apply:

- Keep the existing request/run fields, enumeration executor, metadata task
  seeding, individual anchored `ownerOf` phase, catch-up and collection-live gates.
- Keep all 111K identity, ABI and inventory rules in its extension modules.
- Keep ordinary ERC721 transfer routing for mints and burns; add no mint watcher,
  supply polling or special activity semantics.
- Keep the existing empty-anchor restriction: an empty inventory fails visibly.
- Keep canonical `tokenURI` metadata and ordinary presentation fallbacks.
- Keep artifact refresh as an eventual side lane. Its 111K implementation returns
  `{ attributesChanged: false }` and performs no RPC reads or writes.

The following remain deferred:

- `BKL-037`: durable enumeration pages, broader concurrency and anchor-owner reuse.
- `BKL-061`: crash-safe completion of enumeration plus all metadata task seeding.
- General scope/strategy separation, new enumeration modes, arbitrary ERC721
  discovery, custom renderers, synthetic production tokens and marketplace policy.

Unavailable or incomplete metadata now enters the core
[permanent pending backlog](../indexer/20-metadata-pending-backlog.md).
Bootstrap's initial settlement remains independent of eventual reveal readiness.
The 111K extension requires non-placeholder media. Contract-identified crates,
warehouses and relics, and artwork metadata explicitly categorized as an egg,
are ready without `collection block`. Other responses still require that root;
a declared reveal flag does not replace it. Accepted eggs rely on later metadata
events or explicit refreshes for replacement. No trait restructuring is included.
The extension schedules incomplete-content checks at absolute ages of 5m, 15m,
1h, 3h, 5h, 8h, 13h, 21h and 24h after the first incomplete response. A final
unsuccessful check leaves an exhausted obligation outside automatic work;
later metadata events or explicit refreshes can reopen it. Transport outages
have no age cutoff, and downtime postpones the final check.

## Setup and admission

[`resolveEmbeddedCollectionBootstrapPreset`](../../shared/extensions/built-ins.ts)
returns the identity-based recommendation before scope selection. The backend
probe use case obtains it through its injected preset resolver and returns
nullable `embeddedCollectionPreset` alongside the actual chain findings. The
RPC probe does not invent extension facts or change `enumerable.supported`.
Ordinary JSON and streamed responses retain the same field.

The setup form reuses its existing apply-action family:

1. Probe the mainnet address to offer **entire contract**, with the Enumerable
   finding still false.
2. Applying the suggestion changes scope only. The user can still deliberately
   choose a manual range/list; re-probing does not replace entered scope.
3. Withhold the preset's circulating-supply range suggestion and the misleading
   enumeration-unavailable warning while a current matching preset is present.
4. Discard stale recommendations after address/network changes through the
   existing request-generation fences.

[`bootstrap-contract-probe.ts`](../../frontend/src/lib/bootstrap-contract-probe.ts)
owns those shared display decisions. The existing scope tooltip describes current
and future contract tokens without claiming that every contract is Enumerable.
No additional mode selector, banner or implementation explanation is introduced.

Admission remains authoritative in
[`CreateBootstrapRunUseCase`](../../backend/src/application/use-cases/bootstrap/create-bootstrap-run.ts).
The server resolves the extension key from chain/address/submitted scope; neither
a successful probe nor a client-provided extension key is required. HTTP-to-SQLite
tests verify the key and all-contract scope, including null range/list fields,
and rejection of client attempts to select the hook for manual scope.

## Enumeration and dispatch

[`IndexerCollectionExtension`](../../indexer/src/application/collection-extensions/types.ts)
has an optional `enumerateBootstrapTokenIds` hook. Its context contains a narrow
RPC port, enabled install, contract, exact `ChainBlockReference` and progress
callback. It returns confirmed present IDs into the existing executor.

[`bindCollectionExtensionBootstrapEnumerator`](../../indexer/src/application/collection-extensions/bootstrap-enumeration.ts)
checks the requested key and the install's chain, collection and enabled state.
Bootstrap composition passes the bound callback as the optional final argument
to [`resolveTokenIdsForRun`](../../indexer/src/application/bootstrap-token-enumeration.ts).

Dispatch order is:

1. Manual range/list: keep the existing anchored ownership-filtering path.
2. Entire contract with a requested installed hook: require the exact anchor hash
   and invoke the hook.
3. Entire contract without a hook: keep the existing Enumerable path.

A missing/disabled/mismatched requested install, missing implementation or hook
failure fails visibly. There is no fallback to a guessed range, partial inventory
or `tokenByIndex` after a hook error. Terraforms has no inventory hook and retains
its ordinary Enumerable path.

## 111K inventory algorithm

The implementation is
[`indexer/src/application/collection-extensions/111k.ts`](../../indexer/src/application/collection-extensions/111k.ts).

1. Validate the install, mainnet deployment configuration, context identity and
   non-null exact anchor hash. Reject anchors before deployment. Fetch a fresh
   anchor header and verify its number/hash.
2. Read `totalSupply` through `readContractAtBlock` at that exact canonical hash.
   Supply is a completeness checksum, not a candidate count or maximum token ID.
3. Read deployment-through-anchor mint Transfer logs in pages of at most 2,000
   blocks, with `args: { from: zeroAddress }` and the existing ERC721 event ABI.
   The RPC adapter owns endpoint selection, retries, budgets and further splitting.
4. Validate each selected log's address, requested block range and successful
   mint decoding through `decodeNftTransferLog`. Malformed selected logs fail;
   they are not silently ignored. Deduplicate IDs and sort numerically with bigint.
5. Resolve candidates in positional batches of at most 150 using anchored
   `getTokenInfos`. Validate result count, kinds, display IDs and owners through
   `normalizeErc721Owner`. Exclude only consistent confirmed absence.
6. Require present count to equal anchored supply, re-read that same exact-anchor
   supply and recheck the fresh header before returning.

No RPC failure or unavailable historical state becomes token absence. The
adapter's configured retries are exhausted before the existing executor records
the failure. A normal retry rescans the bounded history; there is no durable page
cursor in this feature.

Progress begins with `{ resolved: 0, total: null }` during discovery, then counts
checked candidates against candidate count. The executor's final seeded count is
present IDs. It does not switch progress units between blocks and NFTs. The
in-memory candidate set and returned array follow the existing executor boundary;
network pages and ownership batches stay bounded.

The existing later ownership phase still reads individual `ownerOf` values.
Bootstrap catch-up starts at `anchor + 1`; realtime continues after the ordinary
live gates. Burned token records may remain browseable even after their balances
are removed. Unavailable metadata remains in the permanent pending backlog
independently of initial snapshot settlement.

## Implementation verification

The maintained deterministic checks cover shared identity/scope, backend
JSON/streamed probe and admission, hook dispatch, malformed/absent ownership,
exact anchors, batching, checksum failures, executor fences, artifact no-ops,
metadata handoff and transfer projection. Browser tests use the production setup
component through the existing fixture harness at desktop and narrow viewports.
The mainnet scenario uses `?chain=ethereum&opensea=disabled`; chain-change coverage
navigates to Arbitrum and verifies that the mainnet preset cannot leak.

The replacement captured fixture is
[`111k-warehouse-opening.json`](../../indexer/tests/fixtures/111k-warehouse-opening.json).
It contains actual mainnet anchor/opening headers, eight relevant transactions
and receipts, and all 337 contract Transfer logs through block `26392804`.
At anchor `26392803`, 275 ever-minted candidates reduce to 272 present IDs. The
component test uses reconstructed, controlled state replies and data-URI metadata.
Its later ownership phase still makes 272 individual anchored `ownerOf` reads.

The warehouse opening transaction
`0x8f684c6a9cb7f10bd015f03f3c54702b8d67ec904fde1236aee9accc28876ffa`
burns warehouse `116717` and mints crates `113087..113097`. The same block includes
other mint/open operations: 56 total mints and three burns produce 325 balances.
Catch-up cannot complete until that block's coverage is persisted. The existing
live executor then completes the run, and duplicate replay preserves counts.

A separate explicitly synthetic realtime block adds crate `116666` and receipt
IDs `1000001`, `2000001` and `3000001`, producing 329 balances. An artwork-only
range excludes the captured warehouse-opening transaction. The successful
snapshot, catch-up and realtime assertions retain all-contract tracking scope.
Synthetic events and controlled metadata do not establish live receipt or CDN
readiness.

A read-only public RPC observation at finalized block `26392979`, hash
`0xfff09a261686e1f5b518a322acc01db048636b83e784c4a475fe8098b20dd1e0`,
reported supply 3,498. Reconstructing mint/burn history through that anchor also
produced 3,498 owners from 3,662 distinct minted IDs. This is a fixed observation,
not an expected future count. PublicNode served that history and the finalized
supply read, but the production adapter's read at the older replay anchor failed
with historical state unavailable. A later read-only run through the production `ViemRpcProvider` and 111K hook
succeeded at fresh finalized block `26393011`, hash
`0xaa512a787c3132336d74eee2e51d5a2d8732e0e1d65e63dd96d62660b8271f18`.
It checked 3,793 minted candidates and returned 3,623 present IDs, with anchored
supply and fresh-header rechecks. This verifies the public endpoint's log and
exact-hash state paths at that anchor, not its older archive coverage or a queued
application bootstrap.

Local qualification after the mainnet update: 104 focused indexer tests, 147
backend probe/API tests, 63 shared definition/scope tests and 25 frontend helper
tests passed. All eight 111K Playwright scenarios passed at desktop 1920×1080 and
Pixel 7 412×839 CSS viewports, including failure/retry and address/chain changes.
Production and focused test type checks passed. Frontend checking reported zero
errors and 87 warnings. Documentation, changed-file formatting and diff checks
passed. A tracked-file scan found no obsolete network identity references.

Local checks use worktree-local databases and temporary directories. Inspect
`.env.test` first because its loader overrides exported test inputs. Focused
commands follow the existing workspace scripts:

```sh
mkdir -p tmp/111k-mainnet
export ARTGOD_WORKSPACE_ROOT="$PWD"
export ARTGOD_DB_PATH="$PWD/tmp/111k-mainnet/tests"
export TMPDIR="$PWD/tmp/111k-mainnet"
export SQLITE_TMPDIR="$PWD/tmp/111k-mainnet"
yarn workspace @artgod/indexer test tests/111k-bootstrap-enumeration.test.ts tests/111k-bootstrap-sync.test.ts tests/bootstrap-token-enumeration.test.ts tests/bootstrap-token-ownership.test.ts tests/bootstrap-enumeration-executor.test.ts tests/embedded-collection-extensions.test.ts tests/collection-extension-refresh-worker.test.ts tests/bootstrap-collection-extension-artifacts.test.ts tests/collection-scope-resolver.test.ts
yarn workspace @artgod/backend test src/application/use-cases/bootstrap/probe-collection-contract.test.ts src/api.test.ts
yarn workspace @artgod/backend test --root ../shared --config ../backend/vitest.config.ts extensions/111k.test.ts bootstrap/scope.test.ts collections/token-scope.test.ts
yarn workspace @artgod/frontend test src/lib/bootstrap-contract-probe.test.ts src/lib/bootstrap-setup.test.ts
yarn workspace @artgod/frontend test:bootstrap:probe --grep 111K
yarn exec tsc -b shared backend indexer
yarn workspace @artgod/frontend check
yarn check:docs
git diff --check
```

Logs and read-only discovery artifacts are retained under `tmp/111k-mainnet/`;
rendered screenshots use `tmp/bootstrap-revamp-playwright/`. These ignored local
artifacts are separate from the reusable tracked mainnet fixture. Native
packaged-app, running NATS bootstrap, live metadata, CI and release verification
remain distinct from local component/browser checks. No live app data is changed
by these checks.

## User mainnet validation

1. Rebuild/relaunch the affected backend, indexer and frontend components. Native
   packaged resources require the normal desktop rebuild/relaunch.
2. On Ethereum, probe the exact mainnet address, apply **entire contract**, inspect
   an existing sample and queue a fresh bootstrap without a manual token count.
3. Confirm the request uses mode `enumerable`, extension key `111k`, chain ID `1`
   and all-contract scope with null range bounds. A complete CLI definition with
   `--entire-contract --chain-id 1 --chain-ref ethereum` resolves the same extension
   independently of a UI preview.
4. Confirm the configured RPC pool serves deployment-through-anchor logs and
   exact-hash historical state. Record the worker anchor/hash and candidate/present
   counts, then verify snapshot completion, catch-up and live status. Compare
   supply at that same anchor, rather than using the fixed observations above.
5. Inspect high-ID containers and, as real operations occur, verify new IDs,
   owners, burns and metadata availability. Keep marketplace and bidding choices
   explicit; this extension does not change their policy.

6. Inspect the permanent metadata backlog and its readiness logs/metrics during
   reveals. Verify a missing `collection block` retries until ready or until
   a final unsuccessful content check exhausts it at or after 24 hours. Confirm
   that a later metadata event reopens exhausted work. Check pause/resume and
   restart without manually editing data or holding delayed metadata jobs in NATS.

Durable enumeration/seeding remain separate deferred work. Permanent metadata
recovery is implemented as described in the [backlog contract](../indexer/20-metadata-pending-backlog.md);
this installed-desktop live qualification remains user-run.
