# 111K Sepolia Bootstrap Development Plan

Enable a fresh bootstrap of the current 111K Sepolia deployment without scanning
its possible future token IDs. Track the entire contract so existing high-ID
containers and future artwork, container and receipt mints use ordinary onchain
sync. Use a small embedded extension to discover the initial inventory.

Implementation status and priority belong to
[`BKL-073`](../planning/01-unified-backlog.md). This is an implementation
specification; the [extension-system reference](01-collection-extensions.md#bundled-extension-111k)
describes the implemented behavior. The constraints below are retained for review
and the user's Sepolia pilot. Source contracts were
checked on **2026-11-11** against ArtGod
`24cff044058135ec177e8f6c25e200cbaa7cff54`, also the local `main` at that check.
Recheck the named call sites if the implementation starts from another revision.

The coordinating session owns the plan and review of deviations. A separate
implementation session owns code changes and their local verification. The user
owns purging the earlier test collection and testing the rebuilt app on Sepolia.

## Scope and settled decisions

The outcome is deliberately specific to the verified v17 deployment. Keep the
existing bootstrap request, run fields, task seeding, ownership phase, catch-up
and live gates. The minimum core addition is an optional extension enumeration
hook and its dispatch. Keep all 111K identity, ABI and inventory rules inside
the extension's modules.

| Decision                   | Implementation requirement                                                                                                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collection universe        | Existing `contract_all_tokens`; includes receipt NFTs as well as originals.                                                                                                                                                |
| Request representation     | Keep `{ "mode": "enumerable" }` for the existing **Entire contract** choice. For this installed extension, its hook supplies enumeration instead of `tokenByIndex`. Do not claim the contract implements ERC721Enumerable. |
| Initial inventory          | Mint `Transfer` IDs from deployment through the worker anchor, filtered by anchored `getTokenInfos` reads.                                                                                                                 |
| Setup default              | Offer the existing **entire contract** apply action when the probe returns the embedded preset. Applying it changes scope only. Suppress the misleading supply-as-range suggestion for this preset.                        |
| Ongoing mints and burns    | Existing NFT Transfer sync and collection routing. No custom mint watcher or supply polling.                                                                                                                               |
| Snapshot owners            | Keep the existing later `ownerOf` reads. Reusing the extension's batch owners is deferred with `BKL-037`.                                                                                                                  |
| Restart model              | Keep the existing executor and its current recovery limits. An enumeration retry can rescan the bounded history. No durable page schema.                                                                                   |
| Previous narrow collection | User purges and reruns. No scope migration, SQL repair or rebootstrap feature.                                                                                                                                             |
| Chain support              | Sepolia v17 only. No guessed mainnet address, broad name matching or automatic chain provisioning.                                                                                                                         |

The following remain **out of scope and are not prerequisites**:

- `BKL-061`: crash-safe completion of enumeration plus all metadata task seeding.
- Guaranteed durable retry when a new token's URI or metadata is initially absent.
- `BKL-037`: durable enumeration pages, broader concurrency and owner reuse.
- General scope/strategy separation, new enumeration modes, a strategy registry,
  new queue kinds, new settings, database migrations and arbitrary ERC721 support.
- General artifact capability cleanup, extra renderers, synthetic tokens, custom
  traits, custom activity semantics, marketplace/bidding support and changelog work.

The earlier diagnostic design proposed broader durability work. This narrower
scope supersedes that proposal. Preserve existing guards, but do not make the
deferred work an implementation dependency or describe it as fixed afterward.

## Deployment and historical acceptance evidence

Own these values in a new `shared/extensions/111k.ts`, exported through
`shared/package.json` as `@artgod/shared/extensions/111k`. Use a legal identifier
prefix such as `NFT111K_`, not an identifier beginning with a digit.

| Property              | Verified value                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Extension key         | Proposed wire value `111k`; define once as `NFT111K_EXTENSION_KEY`.                                                  |
| Chain ID              | `11155111`                                                                                                           |
| Contract              | `0xAca342968965Ddb20baDb1943B99Ee6523658619`                                                                         |
| Deployment block      | `12092412`, inclusive when reading mint logs.                                                                        |
| Creation transaction  | `0xa64760fdefcb0d2bce0bc603a4dfa729507071a343d8879bb62920a4c1a86d3b`                                                 |
| Batch ownership limit | `150` IDs per `getTokenInfos` call.                                                                                  |
| Original caps         | 111,111 artworks; 5,555 crates; 505 warehouses; 18 relics. They are facts, not enumeration counts or routing limits. |
| Verified source       | [v17 contract on Etherscan](https://sepolia.etherscan.io/address/0xAca342968965Ddb20baDb1943B99Ee6523658619#code).   |
| Observed runtime hash | `0x50abe2ebb7c4ee102c9e86ab0f7d2a9e481bee63a5bce3b92482d88ac1848c55`, from 24,537 bytes of deployed code.            |

Normalize the address with the existing shared address owner. Put the deployment
address/block in the extension's embedded configuration, following the existing
Terraforms definition pattern. Do not seed a prepared collection or chain row.
No runtime source fetch or Etherscan API key is required by the feature.

The following observations are **historical fixtures from 2026-11-09**, not the
expected current HEAD inventory:

- Anchor `12094314`, hash
  `0x9e15ad1ee113b4e5e97e979ba7ea7b226762540aaa866c1f379088ddcb9f1446`.
- 420 Transfer events: 398 mints, 20 burns and two other transfers. The 398
  distinct issued IDs reduced to 378 live NFTs: 360 artworks, 17 crates and one
  warehouse. Three anchored batch calls matched every reconstructed owner.
- Live IDs were `1..360`, `111891`, `111893..111901`, `111903`,
  `111905..111906`, `111908..111909`, `111911..111912`, and `116668`.
- `totalSupply()` at the creation block was zero. The verified constructor does
  not mint; NFT111K's reachable mint paths emit ordinary ERC721 Transfer events.
  Do not extend this assumption to arbitrary contracts or ERC2309 constructors.
- `allocatedCrates = 823` included reserved units; only 35 crate NFTs had ever
  minted. The generic probe returned supply 378, not an exact minted range.

The separate receipt ranges are `1000001..1222222`, `2000001..2005555` and
`3000001..3000018`. Thus neither `1..378` nor `1..117189` is a full-contract
tracking scope. Mint-log discovery includes receipts without implementing their
allocation rules. v17's `stats` returns a fifteen-field struct; do not reuse the
older v14 flat fourteen-field ABI. This feature does not need `stats`.

The diagnostic artifacts in the planning checkout's
`tmp/111k-v17-bootstrap-discovery/` are optional supplementary evidence. They
are ignored files and will not follow a Git checkout. The contract, anchor,
expected IDs, wire methods and real transition below are sufficient to recreate
fixtures; tests must not depend on that temporary directory.

## Current integration points

| Owner and current symbol                                                                                                                                     | Verified behavior and proposed change                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Shared scope](../../shared/bootstrap/scope.ts), `bootstrapScopeModel`                                                                                       | `Enumerable` already maps to all-contract scope. Keep its serialized representation and manual modes.                                                                                                     |
| [Embedded registry](../../shared/extensions/built-ins.ts), `BUILT_IN_COLLECTION_EXTENSION_MATCHES`                                                           | Currently contains Terraforms only. Add the 111K exact chain/address/all-scope match and preset lookup in this owning registry.                                                                           |
| [Embedded match contracts](../../shared/extensions/index.ts), `EmbeddedCollectionExtensionMatch`                                                             | Installation matches chain, normalized address and exact scope. Add optional preset metadata; keep installation matching exact.                                                                           |
| [Probe use case](../../backend/src/application/use-cases/bootstrap/probe-collection-contract.ts), `ProbeCollectionContractUseCase`                           | Has no selected-scope dependency. Add a narrow injected preset resolver and return its identity-based recommendation.                                                                                     |
| [Backend resolver](../../backend/src/infra/collection-extensions/built-in-collection-extension-resolver.ts), `BuiltInCollectionExtensionResolver`            | Already previews embedded cache policy without an install row. Extend this adapter for the pure preset lookup.                                                                                            |
| [Create run](../../backend/src/application/use-cases/bootstrap/create-bootstrap-run.ts), `resolveRequestedExtensionKey`                                      | Already derives the extension key from authoritative chain/address/scope and persists it. No probe success or client-provided key is needed.                                                              |
| [Bootstrap worker](../../indexer/src/runtime/bootstrap-worker.ts), `processBootstrapMainClaimedStep`                                                         | Calls `ensureRequestedCollectionExtensionInstalled` after anchoring and before enumeration. Its enumeration composition currently always calls `resolveTokenIdsForRun`. Dispatch the optional hook there. |
| [Enumeration resolver](../../indexer/src/application/bootstrap-token-enumeration.ts), `resolveTokenIdsForRun`                                                | Entire-contract currently calls `totalSupply` and `tokenByIndex`. Add only an optional bound extension enumerator ahead of that fallback. Manual paths stay unchanged.                                    |
| [Enumeration executor](../../indexer/src/application/bootstrap-enumeration-executor.ts), `BootstrapEnumerationResolverPort`                                  | Consumes `Promise<string[]>` of confirmed present IDs and then seeds metadata. Keep this boundary, lease checks and completion behavior.                                                                  |
| [Indexer extensions](../../indexer/src/application/collection-extensions/index.ts) and [types](../../indexer/src/application/collection-extensions/types.ts) | Registry is keyed by extension key; there is no inventory hook today. Add one optional hook and the 111K implementation.                                                                                  |
| [RPC port](../../indexer/src/ports/rpc.ts) and [adapter](../../indexer/src/infra/rpc/viem.ts)                                                                | `getLogs` accepts one event and indexed `args`; `readContractAtBlock` uses exact canonical hash. Reuse them; do not create another RPC client.                                                            |
| [Transfer decoder](../../indexer/src/application/nft-transfers.ts), `decodeNftTransferLog`                                                                   | Already decodes standard ERC721 Transfer. Reuse its ABI/decoder and validate selected log decoding; do not duplicate topic parsing.                                                                       |
| [Scope router](../../indexer/src/infra/collections/sqlite.ts), `resolveTokenScopedCollectionId`                                                              | Delegates to the persisted collection scope, including for new mint IDs. No change needed.                                                                                                                |

The frontend entry point is
[`BootstrapRunsPageView.svelte`](../../frontend/src/lib/components/BootstrapRunsPageView.svelte).
It already offers **Entire contract**, but recommends it only for confirmed
Enumerable contracts and otherwise shows an Enumerable warning. Its
[`bootstrapRangeSuggestions`](../../frontend/src/lib/bootstrap-contract-probe.ts)
helper currently suggests circulating supply for an unknown standalone contract.

## Shared registration and preflight contract

### Embedded definition

Add `NFT111K_EMBEDDED_EXTENSION_MATCHES` to the existing registry. Its only
match is Sepolia v17 with `AllContractTokens`; its install configuration contains
the normalized contract and deployment block. Add optional `bootstrapPreset`
metadata to `EmbeddedCollectionExtensionMatch`, with a recommended
`scope: BootstrapScope`. A type-only import of that existing scope contract is
sufficient. Do not create a second contract-address table.

Add `resolveEmbeddedCollectionBootstrapPreset({ chainId, contractAddress })` in
`shared/extensions/built-ins.ts`. Resolve only entries carrying preset metadata;
return their extension key and scope, or null. The lookup deliberately precedes
scope selection. The existing install resolver still validates the final scope.
Terraforms need not acquire new preset metadata in this change.

### Probe response and backend wiring

Add this nullable field to `BootstrapContractProbeResponse` in
[`shared/bootstrap/probe.ts`](../../shared/bootstrap/probe.ts), using an exported
shared type for the small result:

```ts
embeddedCollectionPreset: {
    extensionKey: CollectionExtensionKey;
    scope: BootstrapScope;
} | null;
```

Keep `BootstrapContractFindings` as the existing chain-observation contract.
The use case adds the preset to its response; the RPC probe does not invent
embedded extension facts or change `enumerable.supported` to true.

Define a use-case-local `BootstrapPresetResolverPort` exposing the identity
lookup. `BuiltInCollectionExtensionResolver` implements it using the shared
registry. Inject that existing adapter as a required collaborator into
`ProbeCollectionContractUseCase`; update all construction sites, including:

- `backend/src/index.ts`;
- `backend/src/testing/bootstrap-live-http.ts`;
- `backend/src/api.test.ts` and probe use-case tests.

Unknown contracts return null. No DB install row, history request, ID walk,
metadata request beyond existing sample inspection, or new counter RPC is needed
for preset resolution. UI clients cannot supply an extension key to admission.

Update the response schema in
[`docs/backend/openapi.yaml`](../backend/openapi.yaml), shared test response
builders in `shared/testing/bootstrap-probe.ts`, fixture routes and response
assertions. The HTTP adapter's ordinary JSON and streamed operation result must
both retain the field through the existing response wrapper.

### Frontend scope recommendation

Keep the existing select and apply-action family. For a successful current-address
probe with a full-contract preset:

1. Offer **entire contract** as the scope suggestion even though Enumerable is
   false. Applying it calls the existing scope setter and preserves other inputs.
2. Suppress the preset's circulating-supply range suggestion. A user can still
   deliberately enter a manual range/list; that request does not install the
   full-contract extension or use its hook.
3. Keep the ERC721Enumerable finding false in the contract facts. Suppress the
   misleading enumeration-unavailable warning only when a matching preset
   supplies full-contract enumeration.
4. Correct the existing scope tooltip's claim that Entire contract always uses
   ERC721Enumerable. Do not add strategy names, a new mode selector, a banner,
   a capabilities table or implementation prose to the product UI.

Put shared decision logic in the existing `bootstrap-contract-probe.ts` helper
module, rather than duplicating preset interpretation in the component and tests.
`BootstrapContractProbeResponse` is already re-exported by
`frontend/src/lib/api-types.ts`; keep that ownership. A small optional preset
argument to `bootstrapRangeSuggestions` can preserve its findings-only consumers.

Use `latestProbeMatchesAddress` and the current request-generation fences. Never
apply a late response after an address/network change, overwrite an explicitly
entered scope during a re-probe, or change scope merely because a sample returns.
This plan deliberately uses an apply action instead of another auto-fill state
machine. With a missing/failed probe, manual queueing retains current semantics.

## Optional enumeration hook and dispatch

Add an optional method to `IndexerCollectionExtension`. A proposed minimal
context is shown below; preserve its semantics if names change:

```ts
type CollectionExtensionBootstrapEnumerationContext = {
    rpc: Pick<RpcProviderPort, "getLogs" | "getBlock" | "readContractAtBlock">;
    install: CollectionExtensionInstall;
    contract: string;
    anchor: ChainBlockReference;
    onProgress(progress: { resolved: number; total: number | null }): void;
};

interface IndexerCollectionExtension {
    // Add this optional method alongside the existing methods.
    enumerateBootstrapTokenIds?(
        context: CollectionExtensionBootstrapEnumerationContext,
    ): Promise<string[]>;
}
```

The extension returns confirmed **present IDs**, not all minted candidates and
not a replacement tracking scope. It owns its temporary batch owners and discards
them after producing the IDs; the existing ownership phase remains authoritative.

In bootstrap composition, bind the hook using `collectionExtensions.getInstall`
and `resolveIndexerCollectionExtension`. Require an enabled install matching the
run's chain, collection and `requestExtensionKey`. Pass a bound generic callback
as an optional final argument to `resolveTokenIdsForRun`; keep its current callers
valid when no callback is supplied. Do not import 111K constants into that resolver
or add a 111K address switch to the runtime worker.

Dispatch order:

1. Manual range/list: use the existing path, with no extension dispatch.
2. Entire-contract run with a selected, installed extension hook: require its
   anchor hash and invoke the hook with the run's exact block reference.
3. Entire-contract run without a hook: use the existing Enumerable path.

A requested extension with a missing/disabled/mismatched install or missing
implementation fails visibly. A hook exception propagates; it must not silently
fall back to `tokenByIndex`, a guessed range or partial inventory. An installed
Terraforms implementation with no hook still follows its ordinary Enumerable path.

Keep existing executor completion fences. Hook progress must not invent durable
page completion, alter liveness gates or attempt to solve generic progress lease
fencing. The new callback returns through `BootstrapEnumerationExecutor` exactly
like the old resolver result.

## 111K inventory algorithm

Implement `111k.ts` under `indexer/src/application/collection-extensions/`, with
small private sibling modules only when they serve a distinct responsibility.
Register it in the current indexer extension registry. Own the narrow read ABI,
method-name constants, `ItemKind.None`, batch limit and any extension log labels
there or in the shared 111K definition when another package actually consumes
them. Tests consume those exports except when asserting external wire encoding.

The only custom contract reads needed are:

```ts
parseAbi([
    "function totalSupply() view returns (uint256)",
    "function getTokenInfos(uint256[] tokenIds) view returns ((uint8 kind, uint256 displayId, address holder)[] infos)",
]);
```

This is viem's human-readable ABI; the existing `parseAbi` accepts its tuple-array
result. `getTokenInfos` returns `(0, 0, address(0))` for burned or unissued IDs and
enforces a maximum batch of 150. Define the extension ABI once using its owning
method-name constants; the strings above describe the external wire contract.

### Validate the anchor and configuration

Validate install key/enabled state, chain, address, configured deployment block
and context identity against the single v17 definition. Reject a different
deployment instead of guessing from its name or caps. Require a non-null exact
anchor hash and an anchor at or after deployment. Read the fresh anchor header
with `getBlock(anchor.blockNumber, { fresh: true })` and compare its hash.

Read `totalSupply` through `readContractAtBlock` with that exact anchor. It is a
checksum for the complete contract, not a candidate count or token-ID endpoint.
No current-state probe result is snapshot evidence. Retain the existing behavior
that an empty anchor inventory cannot complete bootstrap; supporting a first mint
after an empty snapshot is not required for this already-minted deployment.

### Discover minted candidates

Read bounded block pages from configured deployment **inclusive** through anchor
**inclusive**. An extension-owned page span of 2,000 blocks is an acceptable
initial shortcut; define it once with a comment that the RPC adapter may split
it further. Reuse `rpc.getLogs` with `ERC721_ABI[0]` and
`args: { from: zeroAddress }`. The current adapter already supports the indexed
filter and owns endpoint selection, budgets, retries and adaptive range splitting.

For every returned selected log, require the expected contract, requested block
range and one successfully decoded ERC721 mint from `decodeNftTransferLog`.
The decoder returns an empty array on malformed input; that must be an error for
a selected mint log, not an ignored token. Reject an unexpected event or sender.
Deduplicate token IDs across pages and duplicate delivery. Do not retain all raw
logs or query ordinary transfers, burns, wallets or marketplace inventory.

The resulting set contains ever-minted candidates, including later-burned IDs.
Numerically sort the IDs with bigint comparisons for deterministic batching and
first-token selection. Do not expand any maximum ID/cap into a candidate range.

The temporary ID set and final array are accepted here because the current
executor requires an array and the target is this one collection. Keep network
responses/batches bounded. General streaming or persistent cursors are deferred.

### Resolve presence and check completeness

Read candidate batches of at most 150 with `readContractAtBlock(getTokenInfos)`.
Require one result per input and preserve positional association. Normalize each
holder through `normalizeErc721Owner` in
[`shared/evm/erc721-ownership.ts`](../../shared/evm/erc721-ownership.ts).
A consistent None/zero-owner result means confirmed absence; a valid
kind/nonzero holder means presence.
Reject malformed or inconsistent results, a batch/RPC failure or an unavailable
historic state. Do not convert generic exceptions into absent tokens.

Return the distinct present IDs only when `BigInt(presentIds.length)` equals
anchored `totalSupply`. Read/recheck the same exact-anchor state and fresh header
before returning. A checksum/hash mismatch is an error; never truncate the result to the
counter or shrink the persisted collection scope. This checksum is valid because
the installed strategy covers the whole verified contract, not a subcollection.

During mint discovery, total work can remain unknown. Report an initial
`{ resolved: 0, total: null }`; once candidates are known, report checked
candidates against candidate count during ownership filtering, as the current
manual enumerator does. The final seeded-token count is present IDs. Do not
switch the progress unit between blocks and NFTs or report 398 live NFTs for the
historical fixture. The executor already logs a heartbeat during resolution.

At the historical anchor this does one external log page plus three batch reads
for 398 candidates; checksum/header reads are additional. The existing ownership
phase then makes 378 individual reads. **Three batch calls is not an end-to-end
bootstrap RPC budget.** This deliberate small redundancy replaces the 117,189
candidate scan without expanding the change into owner-reuse work.

### Ordinary retries and errors

Let the injected RPC adapter exhaust its configured endpoint retry policy.
Remaining errors propagate into the existing enumeration executor, which marks
the step/run failed. Use existing retry controls after correcting the cause.
Do not invent durable per-page resume or silently retry with a different anchor.
On an ordinary re-execution, rebuilding the in-memory set from deployment is
acceptable. Existing partial metadata-task recovery and its `BKL-061` crash gap
remain unchanged and must be reported as such.

### Other extension methods

Supply `buildSyncWatchSpecs` as an empty list and `refreshArtifacts` as a no-op
returning `{ attributesChanged: false }`. Do not add renderers, synthetic tokens
or artifact storage. Backend/frontend presentation can use their existing
no-extension fallbacks; registering full presentation implementations is not a
prerequisite for an indexer-only behavior.

Current bootstrap seeding and metadata follow-ups schedule per-token artifact
jobs for enabled installs even without extension-owned artifact seeds. Those
jobs must resolve the registered 111K implementation and complete harmlessly;
do not omit `refreshArtifacts` and leave follow-up runs failing. Empty
`seedBootstrapArtifactTasks` alone does not prevent metadata-derived tasks.
Accept this existing queue overhead for now. Skipping it through a general
capability refactor is deferred, and none of these jobs performs enumeration.

## Existing snapshot and continuous sync

Pass the present ID array into the current metadata seeding/ownership pipeline.
Keep persisted `token_scope_kind = contract_all_tokens` with null range bounds;
do not materialize an explicit scope list from that array. In particular, the
anchor's present subset must never replace the collection's future universe.

Preserve the current post-anchor backfill and collection-live gates described
in [bootstrap](../indexer/14-collection-bootstrap.md). Catch-up starts at
`anchor + 1`, so a mint during probing/bootstrap is included according to its
block, and realtime sync continues afterward. No 111K-specific watcher, create
handler, supply refresh loop or mint counter gate is required.

Burns remove ownership through existing balance projection. Existing burned
token records may remain in the all-token browser; do not change browse semantics
or promise a custom opening activity type. New-token metadata continues using
canonical `tokenURI` and current refresh behavior. Initially missing metadata
has no new guaranteed retry in this work.

## Implementation sequence and review boundaries

Use the user's isolated feature branch. Read `AGENTS.md` and relevant domain
documents before edits. Commit with both `-c commit.gpgSign=false` and
`--no-gpg-sign`; use `--no-gpg-sign` for any rebase. No push, merge or live-data
mutation is part of this plan. Do not update `CHANGELOG.md`.

1. **Embedded identity and probe preset.** Add shared definitions/export,
   extend the owning registry, add the nullable probe field and narrow resolver
   port, wire all constructors, update OpenAPI/fixtures and add identity tests.
2. **111K enumeration and dispatch.** Add the optional hook, the generic bound
   callback at the existing resolver boundary, the registered 111K enumerator
   and no-op artifact behavior. Add exact-anchor, filtering, error, batching and
   fallback tests. Keep database/queue schemas and ordinary sync code unchanged.
3. **Bootstrap setup recommendation.** Add the existing-style apply action and
   warning/suggestion logic, preserving probe-generation and manual-input rules.
   Extend the maintained bootstrap Playwright scenario and perform rendered QA.
4. **Lifecycle qualification and documentation.** Add a disposable-DB component
   integration test covering persisted all-contract scope and post-anchor burns/
   mints, qualify the listed regressions, update current extension/bootstrap
   reference docs and backlog status to match the evidence actually obtained.

Keep tests beside the behavior in each logical commit. Do not start a second
implementation of generic transfer decoding, ownership normalization or RPC
resilience. Do not import unmerged extension-branch changes as a prerequisite.
If a required core change grows beyond the optional hook/dispatch and probe
recommendation, bring the concrete issue to the planning owner before widening
scope; continue independent work meanwhile.

## Required verification

New test filenames below are planned additions; source links above identify
the existing owners. Unit fixtures are deterministic and need no funded wallet,
public RPC, broker or installed system service.

| Boundary                          | Required cases                                                                                                                                                                                                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared registry and backend probe | Exact Sepolia v17 identity yields the preset with no install row. Wrong chain/address and ordinary contracts yield null. Upper/lowercase input normalizes. Probe keeps Enumerable false and ordinary facts unchanged.                                             |
| Admission and install             | Full scope persists `requestExtensionKey = 111k`, all-contract scope and null range/list fields. Manual scope does not install it. A forged/absent preview cannot change server-side matching. Verify via the existing API/SQLite path, not only a registry stub. |
| Dispatch                          | Matching hook precedes `tokenByIndex`; hook error never falls back. Missing/disabled/wrong-key install fails. Terraforms and generic Enumerable/manual paths retain behavior. Existing completion ownership/lease tests continue passing.                         |
| Inventory source                  | Deployment and anchor boundaries included, post-anchor logs excluded, duplicates deduplicated, sparse IDs and high receipt IDs included, ordinary transfers not selected, malformed selected logs fail.                                                           |
| Presence                          | 151 candidates create batches of 150 and 1; results associate with correct IDs. Burned candidates are excluded. Zero/invalid holder combinations, wrong result count, RPC failure and missing historical state fail.                                              |
| Anchor and completeness           | All custom reads receive the same block hash with `readContractAtBlock`. A different returned header/hash, missing anchor, pre-deployment anchor or supply mismatch fails. Nothing uses HEAD/probe owners or `min(maxId, totalSupply)`.                           |
| Handoff                           | Metadata tasks contain only present IDs, persisted scope remains all-contract, and the later ownership phase is still used. Enumeration never occurs in the artifact lane. No-op artifact jobs complete without changing attributes.                              |
| Catch-up and live                 | A mint after preflight/before anchor enters the snapshot; a later mint enters catch-up; realtime mint IDs above 378 and receipt IDs route correctly. A burn removes the balance, and duplicate replay does not double-apply it.                                   |
| UI                                | Full-contract apply action works with Enumerable false; no misleading 378 range suggestion/warning for the preset. Unknown contracts and explicit manual inputs behave as before. Address/network changes and late responses do not leak the preset.              |

For one real component replay, recreate the warehouse opening transaction
`0x508d1a746ba900d19a88a6041582a091f8e0acb81152503a6d5c8a1921af88ee`
at block `12092651`. With an anchored snapshot at `12092650`, it burns one
warehouse and mints crates `111891..111901`. Diagnostic replay started from 41
owned tokens and ended at 51; all 12 events routed under full-contract scope and
none under `1..378`. Use captured fixtures and controlled metadata responses,
with a fresh worktree-local test DB. Add a clearly labelled synthetic receipt
mint scenario if no real receipt has minted yet. Do not submit chain transactions
to manufacture test evidence or imply fixture metadata proves CDN readiness.

Suggested files: extend `indexer/tests/bootstrap-token-enumeration.test.ts`,
`indexer/tests/embedded-collection-extensions.test.ts`,
`indexer/tests/collection-extension-refresh-worker.test.ts`, backend probe/API
tests, and frontend bootstrap helper/browser tests. Add
`indexer/tests/111k-bootstrap-enumeration.test.ts` and
`indexer/tests/111k-bootstrap-sync.test.ts` for focused extension behavior and
the disposable-DB replay. Shared tests use the owner's exported constants unless
deliberately checking external wire values.

After implementing, run the focused checks from the worktree root. For DB tests,
set `ARTGOD_WORKSPACE_ROOT`, `ARTGOD_DB_PATH`, `TMPDIR` and `SQLITE_TMPDIR` to
worktree-local paths under `tmp/111k-bootstrap-tests/`; create that directory
first. The existing test-env loader overrides exported values when `.env.test`
exists, so inspect that file before running. Do not point tests at an app DB.

```sh
yarn workspace @artgod/indexer test tests/111k-bootstrap-enumeration.test.ts tests/111k-bootstrap-sync.test.ts tests/bootstrap-token-enumeration.test.ts tests/bootstrap-token-ownership.test.ts tests/bootstrap-enumeration-executor.test.ts tests/bootstrap-anchor-executor.test.ts tests/bootstrap-backfill-executor.test.ts tests/bootstrap-collection-live-executor.test.ts tests/embedded-collection-extensions.test.ts tests/collection-scope-resolver.test.ts tests/collection-extension-refresh-worker.test.ts tests/bootstrap-collection-extension-artifacts.test.ts
yarn workspace @artgod/backend test src/application/use-cases/bootstrap/probe-collection-contract.test.ts src/infra/bootstrap/viem-bootstrap-contract-probe.test.ts src/http/handlers/bootstrap/inspect-bootstrap-sample.test.ts src/api.test.ts
yarn workspace @artgod/backend test --root ../shared --config ../backend/vitest.config.ts bootstrap/scope.test.ts collections/token-scope.test.ts
yarn workspace @artgod/frontend prepare
yarn workspace @artgod/frontend test src/lib/bootstrap-contract-probe.test.ts src/lib/bootstrap-setup.test.ts
yarn workspace @artgod/frontend test:bootstrap:probe
yarn exec tsc -b shared backend indexer
yarn workspace @artgod/frontend check
yarn check:docs
git diff --check
```

Also run the new shared-definition test and affected artifact-follow-up tests
when added. Format changed supported files with the repository's Prettier and
check their formatting; avoid reformatting unrelated files. Run additional checks
only for changed boundaries or unresolved failures. A typecheck failure must be
classified against the same baseline rather than repaired through unrelated work.

Frontend verification uses the maintained
[`playwright.bootstrap-probe.config.ts`](../../frontend/playwright.bootstrap-probe.config.ts)
and `frontend/e2e/bootstrap-probe.spec.ts`. Extend the fixture owner
`frontend/src/lib/e2e/bootstrap-probe-fixtures.ts` with a Sepolia chain entry;
its chain list currently contains Ethereum and Arbitrum. The harness page loader
already accepts its `chain` query key. Extend the response owner
`frontend/e2e/helpers/bootstrap-probe-api.ts`: its `contractResponse` currently
falls back to an Enumerable fixture for an unknown address, so add an explicit
111K scenario with the correct chain, Enumerable false, sample response and
preset. Do not test recognition by attaching the Sepolia preset to an Ethereum
response. Exercise `?chain=sepolia&opensea=disabled` and the existing network-change
control as well as changed-address requests.

Inspect the complete setup surface at the existing desktop and narrow viewports,
including loading, selected, editable and failure states. Follow the
[UI copy check](../ui/00-user-perspective-and-language.md#mandatory-ui-copy-check).
Do not substitute host GUI automation.

Earlier frontend attempts hit duplicate parent/worktree `pnpapi` ownership of the
shared Svelte compiler and a missing generated tsconfig on an alternate runner.
Use the documented checkout/prepare workflow and existing tools; if still blocked,
record the exact failure and rendered coverage gap. Do not provision browsers,
standalone binaries, host packages or replacement services without authorization.
The existing direct-RPC bootstrap live helper asserts Ethereum mainnet; it is
not a Sepolia qualification harness without explicit adaptation. Prefer the
fixture-based browser test and the user's later real Sepolia run.

## User Sepolia validation and implementation handoff

The user's existing Sepolia runtime/configuration is the pilot environment.
Adding this extension does not provision that environment. The default chain
catalog migration seeds Ethereum only, and RPC auto-sourcing/marketplace paths
retain mainnet assumptions. Keep the user's Sepolia chain catalog, explicit RPCs,
app-data isolation and disabled marketplace/bidding setup; do not alter these
through new generic setup features. A history-capable RPC must serve deployment
through anchor, and a state-capable RPC must accept exact-hash historic calls.
Previously PublicNode served state and `0xrpc.io/sep` served the bounded history;
availability on a later run must be checked rather than assumed.
Qualify both operations through the configured `ViemRpcProvider` endpoint pool;
success through two standalone diagnostic clients alone does not prove that the
runtime pool can perform both. Retain existing endpoint retry/selection policy.

After the user purges the earlier test collection through the existing workflow:

1. Rebuild/relaunch the affected backend/indexer/frontend components; native
   packaged resources require the normal desktop rebuild/relaunch.
2. Probe the exact v17 address on Sepolia, apply **entire contract**, inspect an
   existing sample and queue bootstrap. No manual token count is required.
3. Confirm the persisted request has mode `enumerable`, extension key `111k` and
   all-contract scope. A CLI request using the existing `--entire-contract`,
   `--chain-id 11155111`, `--chain-ref sepolia` and exact address must resolve the
   same extension without depending on a UI preview.
4. Record the actual worker anchor/hash, issued candidate count, present count,
   snapshot completion, catch-up completion and live status. Compare supply at
   that same anchor; do not require today's inventory to equal historical 378.
5. Inspect existing high-ID crates/warehouse alongside artwork. As real later
   operations occur, confirm new IDs/owners and burns across catch-up and realtime.
   Record whether metadata was available; initially missing metadata retains the
   deferred recovery limitation.

The implementing agent reports source/test/fixture evidence separately from a
running queued bootstrap or user-observed chain activity. Do not claim live mint
coverage from a no-mint observation interval, or claim receipt metadata readiness
from a synthetic transfer fixture.

Final handoff includes the unsigned commits, branch and full worktree path,
focused check results, any frontend/runtime verification gaps and the short user
pilot checklist. Update the extension system and bootstrap topic documents when
the feature lands, keeping this plan linked as the implementation contract.

There are no unresolved product decisions required to start this bounded work.
A changed deployment, inability to preserve current guards, or an unexpected core
schema/pipeline dependency is a reason to return a concrete decision to the
planning owner. Cleanup, generalization and the two explicitly deferred issues
are not reasons to expand this implementation.

## Implementation verification

Implemented and locally qualified on **2026-11-11**, from the plan's named
`main` revision. Shared identity/preset resolution, backend probe and admission,
the optional indexer hook, 111K enumeration and the existing setup apply action
are implemented. Hook binding is in
`indexer/src/application/collection-extensions/bootstrap-enumeration.ts`, called
by bootstrap composition before the existing resolver. No schema, queue, ordinary
transfer-sync or changelog change was required.

| Local boundary                                                                                    | Result                                                                                                                               |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Shared definition, scope and token-scope tests                                                    | 63 passed.                                                                                                                           |
| Backend probe, RPC probe, sample HTTP and API tests                                               | 214 passed, including JSON/streamed preset output and authoritative HTTP-to-SQLite admission.                                        |
| Indexer enumeration, ownership, executor, scope, artifact, lifecycle and metadata-follow-up tests | 138 passed across 15 files.                                                                                                          |
| Frontend probe/setup helpers                                                                      | 25 passed.                                                                                                                           |
| Maintained bootstrap Playwright suite                                                             | All 190 passed at desktop 1920×1080 and Pixel 7 412×839 CSS viewports.                                                               |
| Type checks                                                                                       | `tsc -b shared backend indexer` passed; focused changed indexer test/fixture types passed. Frontend check: zero errors, 87 warnings. |
| Documentation and formatting                                                                      | Documentation links/contracts, changed supported-file Prettier checks and `git diff --check` passed.                                 |

Rendered review followed the whole setup surface through editable, loading,
selected, identity-change and failed/retry states, using the existing control
families at both viewports. The only changed product copy corrects the scope
tooltip's Enumerable-only claim. Screenshots are retained under
`tmp/bootstrap-revamp-playwright/`; check logs are under
`tmp/111k-bootstrap-tests/`. These are ignored local artifacts.

The reusable captured fixture is
`indexer/tests/fixtures/111k-warehouse-opening.json`. It contains the opening
transaction/header and 57 real Transfer logs, including the preceding inventory.
The component test reconstructs controlled presence replies from those logs:
43 issued candidates produce 41 present IDs and metadata tasks at anchor
`12092650`. The later ownership phase still makes 41 individual anchored
`ownerOf` reads. The real opening at `12092651` removes one warehouse balance and
adds eleven crate balances, leaving 51. Catch-up cannot complete before that
block's coverage is persisted; the existing collection-live executor then
completes the run. Duplicate projection preserves balances and fact counts.

A separate synthetic realtime block adds a high-ID crate and all three receipt
families (`1000001`, `2000001`, `3000001`), producing 55 balances. Controlled data-URI
metadata creates the new token rows. The same real opening routes zero events
under `1..378`. The persisted scope remains all-contract through the successful
snapshot, catch-up and realtime assertions; no present-ID list becomes the
tracking scope.

These results qualify source, deterministic fixtures and local components. They
do not qualify a running NATS-backed Sepolia bootstrap, the configured endpoint
pool's present historical coverage, CDN metadata readiness, native packaged
resources, CI or a release. No live collection was purged and no chain transaction
was submitted. The user's rebuild, purge/rebootstrap and observed mint/burn pilot
remain the checklist above. `BKL-037`, `BKL-061` and initially unavailable metadata
recovery remain deferred exactly as planned.
