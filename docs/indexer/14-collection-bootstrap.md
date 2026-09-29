# Collection Bootstrap

This document describes the implemented per-collection bootstrap flow.

The goal is to reach a correct local ownership state quickly and then attach OpenSea orderbook tracking without blocking core onchain correctness.

## Why Bootstrap Exists

`nft_balances` is the canonical current ownership table, but it is only correct when:

1. we have a snapshot anchored to a specific block, and
2. we have processed every transfer after that block with no gaps

Full backfill from genesis also works, but it is too expensive for the normal local-first path.

Historical backfill before the anchor is still useful, but only as fact import:

- it can enrich `nft_transfer_events`, `fills`, and downstream historical activity
- it must not mutate `nft_balances` or other current-state/materialized tables

## Prepared Collection Presets

Fresh installs can include prepared collection rows. A prepared row is visible
in the chain collections table and can be purged like any other collection, but
it has no token rows, bootstrap runs, extension install rows, or OpenSea state
written yet.

Terraforms is currently the only prepared preset. The preset contract lives in
`shared/extensions/terraforms.ts` as `TERRAFORMS_MAINNET_PRESET_COLLECTION`,
and migration `051_preset_terraforms_collection.sql` persists it as collection
ID 1 on Ethereum mainnet. The row stores the Terraforms contract identity,
token-scope/deployment hints, and OpenSea slug so the first operator action can
be `start bootstrapping` instead of contract probing plus manual run creation.

Starting a prepared row marks the collection `status = bootstrapping`, creates a
normal bootstrap run from the persisted row, and enqueues
`bootstrap.collection.start`. It does not start automatically on first app
launch.

## CLI Triggers

The trigger uses the admin-capable backend API and defaults to
`metadata-mode=best_effort`. Every request requires an explicit scope:
`--entire-contract`, `--manual-token-ids`, or both manual range flags.
Enumerable support never chooses scope for the user.

```sh
yarn workspace @artgod/indexer run dev:bootstrap-trigger --address <0x...> --slug <slug> --entire-contract --image-source-field image
yarn workspace @artgod/indexer run dev:bootstrap-trigger --address <0x...> --slug <slug> --manual-range-start-token-id <id> --manual-range-total-supply <count> --image-source-field image
yarn workspace @artgod/indexer run dev:bootstrap-trigger --address <0x...> --slug <slug> --manual-token-ids "1,42,1000" --sample-token-id 42
```

A complete definition with `--image-source-field` queues without probing or
downloading metadata. If that field is omitted, the trigger discovers contract
facts and inspects a sample to suggest it. A failed check reports its stage;
the recovery is to supply the field explicitly. Other explicit options include
`--animation-source-field`, `--image-cache-mode`, and
`--image-cache-max-dimension <pixels|original>`. User settings take precedence
over scope-specific extension hints.

`--sample-token-id` selects an inspection example only. It does not change
the declared range/list or require a minted token at its lower boundary.
Manual ranges remain usable on Enumerable contracts.

When `--opensea-slug` is present, the trigger verifies it against the exact
sample's OpenSea NFT identity. That sample must belong to the selected scope.
An unavailable, missing or mismatched association stops this explicitly requested
attachment with recovery guidance. Omit the optional flag to queue onchain
independently. No contract-only lookup or range-boundary verification is used.

Inside the deploy `backend` container, the trigger defaults to the local backend
listener at `http://127.0.0.1:<BACKEND_PORT>`. Use `--backend-origin` only when
calling a different backend origin.

Trigger manual historical backfill from CLI:

```sh
yarn workspace @artgod/indexer run dev:backfill-trigger --from-block <n> --to-block <n> [--collection-id <id>] [--batch-size <n>]
```

## Manual-First Probe Form

The form has five ordered sections: Contract, Token scope, Collection details,
Image cache, and OpenSea. The first three are required; the last two are optional
settings. Section headings identify incomplete setup. The contract-safety
acknowledgement must be checked before any form control can be used. Unchecking
it locks the form again and clears check results while preserving entered fields.

**Contract address or NFT URL** accepts a plain address or a pasted URL containing
an adjacent `<contract address>/<decimal token ID>` path pair. The frontend
immediately replaces a pasted URL with the address and fills **Sample token ID**.
Hostname and preceding path do not select a provider or chain. The selected chain,
token scope and other entered settings stay unchanged. This only parses text;
the next explicit probe or inspection uses the two extracted values through the
existing API. Invalid pairs remain in the input for correction.

Each section uses the same label/input/action grid. Inputs share a left edge and
are sized for their intended content, with single-line **apply "value"** suggestions
in the action column. Status hints are centered vertically against their inputs.
Long suggestions are clipped and expose their complete value through the button's
title and accessible name. The desktop form occupies the left half of the page;
the right half displays the sample's formatted tokenURI response. Narrow viewports
stack these panels and then each row in label, input, action order.

Edits do not make network requests. **probe contract**, beside the address, first discovers
contract facts, then starts sample inspection. Contract supply and capability
suggestions become available while metadata is still loading. **inspect token**, beside
the optional sample input, retries that inspection without repeating discovery.
Each action shows progress inside its button and a failure beside its section.

Every suggestion has its own **apply "value"** action. Applying the start candidate,
contract supply, image/animation field, local slug or entire-contract mode
changes only that setting. First token ID starts empty and requires manual entry
or an explicit apply action; probing never fills it automatically. A matching
value disables the action. A confirmed OpenSea slug adds another Collection slug
suggestion alongside the contract-name suggestion for standalone contracts, with
identical values shown only once. Detected shared contracts suppress the
contract-name suggestion; enter a local slug manually or apply the confirmed
OpenSea slug. Neither source automatically fills the field. Editing the OpenSea slug,
sample or target invalidates its suggestion without changing the local slug.
OpenSea page links use the entered slug and sample identity without requiring an
API key or a successful lookup. Manual slug entry remains available without a key;
resolution and attaching the OpenSea association still require it.
A conventional start suggestion must have confirmed ownership. ID 1 additionally
requires a recognized absence response for ID 0; an unknown read of 0, or
enumeration contradicting its absence, withholds that suggestion. An owned ID 1
can still be used for sample inspection. Current absence does not prove that ID 0
was never minted or cannot be minted later. The First token ID row therefore shows
compact OpenSea links for tokens 0 and 1 whenever the boundary is uncertain,
including beside a conventional ID 1 suggestion, before probing, and after
inconclusive checks. These links use the selected chain/address, require the
contract acknowledgement, and need no OpenSea API key. A confirmed owned ID 0
establishes the smallest possible ID; enumeration order alone cannot do that.
The first enumeration entry is never presented as a range boundary.
Contract-wide supply never establishes one shared project's count. On positively
identified shared contracts, neither global supply nor conventional start IDs
are offered as project range suggestions.

Sample inspection can return `projectScope`: the project ID/name, exact first
token ID, its separate `startTokenOwnership` result, minted count and current
configured maximum. For Ethereum Art Blocks,
this requires current membership in the official mainnet Core Registry and a
supported project model. Legacy cores use `tokenIdToProjectId` and
`projectTokenInfo`; registered V3, Engine and Engine Flex cores use the recognized
`coreType` and `projectStateData`. V3 Explorations reports the flagship V3 type.
An available token-to-project mapping must agree with the million-ID encoding.
The sample must be owned and lie inside the reported minted span; counters must
fit the namespace and the suggested range must fit uint256. All reads use the
same verified block. The first-ID apply suggestion requires confirmed ownership
of the project start at that block; re-use the sample's ownership when it is the
start, otherwise check the start separately. An absent or unknown start withholds
only that apply suggestion and retains project identity and both counts, with
the same token links for manual review. Getter compatibility without registry membership remains
advisory and cannot produce these suggestions.

These are bounded reads for one sampled project, not project enumeration or
generic decimal rounding. A missing project name does not discard valid range
facts. Unsupported models, inconsistent data or failed required reads produce no
project suggestion and leave manual setup available. Project lookup runs
independently of metadata retrieval. Its facts survive metadata errors and are
returned in both the JSON and streamed inspection result; `project_scope`
progress reports the checks and counts as they finish.

The form offers these values beside First token ID and Token count, with a
Token range suggestion beside the scope selector. Each apply action changes
only its own setting. If minted count differs from the configured maximum,
separate **minted** and **maximum** apply buttons make the choice explicit;
maximum includes unminted IDs. Matching counts have one button. The project
identity appears beside the scope selector, while Contract total supply remains
contract-wide. Sample/address/chain edits discard project suggestions without
overwriting the entered scope. OpenSea does not participate in this lookup.

Contract probing can start automatic sample inspection when the sample input is
empty. As soon as the backend selects a token, its progress record fills that
empty input before metadata is downloaded. An explicit override inspects exactly
that ID and is preserved; failed ownership never silently selects a different
token. The separate inspect action is disabled while the input is empty.

The desktop setup output includes `sample.tokenUriPayload` from inspection:
the original metadata text from HTTP/IPFS or a decoded JSON data URI, bounded by
`BOOTSTRAP_TOKEN_URI_MAX_BYTES` (10 MiB). Invalid JSON remains inspectable;
unavailable or oversized responses return null with a separate download/parse
outcome. No image is downloaded during contract discovery or sample inspection.

### Live Setup Output

All five setup routes accept `Accept: application/x-ndjson`. Without that header,
their existing JSON responses and HTTP error statuses remain unchanged. The form
uses the streaming representation; CLI callers can keep the ordinary response.
Authentication, origin and CSRF checks apply before either representation starts.

Each UTF-8 line is one JSON record. A `progress` record carries `operation`,
request-local ascending `sequence` (starting at 1), UTC `timestamp`, `step`,
`status`, `message`, and optional exact resource `url` or bounded original `text`.
The successful `inspect` / `sample` record also carries the selected `tokenId`
as a canonical decimal uint256 string, before metadata work starts.
Statuses are `started`, `succeeded`, `failed`, `skipped`, `retrying`, and
`completed` (operation finished, including any reported partial failures). Parallel
checks appear in completion order. An operation ends with exactly one `result`
record containing its ordinary response, or an `error` record containing
`statusCode`, `error` and `message`. After streaming headers, the error record
carries the failure status; the outer HTTP response remains 200. A missing final
record is an interrupted operation, never a successful check. Partial metadata
failure can return a result while its individual step reports failure.

| Operation  | Required output                                                                                                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `probe`    | Finalized block/hash; code and proxy checks; interface support; name; contract-wide supply; enumeration candidate; each ownership candidate; block verification.                                                                                       |
| `inspect`  | Block and ownership checks; chosen sample; optional recognized project lookup and range/count facts; exact tokenURI; resolved public HTTP URL; each request/status/retry delay; received bytes and original text; JSON validation; block verification. |
| `estimate` | Exact source URL and HTTP attempts; received bytes/type; processing settings; source/output dimensions and cached bytes; distinct download and processing failures.                                                                                    |
| `resolve`  | Exact public OpenSea NFT URL and attempts; discovered association and requested-slug verification. API keys and request headers are excluded.                                                                                                          |
| `queue`    | Definition validation; collection/scope conflict checks; admitted run ID and queue result. Subsequent worker progress belongs to the existing run-detail page.                                                                                         |

Output contracts live in `shared/bootstrap/operation-output.ts`; the form and
live-check command share the reader in `shared/bootstrap/operation-stream.ts`. Reports are
request-local callbacks through the owning use cases and adapters; there is no
durable setup job, command interpreter or separate logging service. Existing
HTTP/RPC/OpenSea retry policies remain authoritative. The frontend never replays
a started streaming operation automatically. Explicit retry appends new history.
Address/chain changes and removing acknowledgement clear history; sample edits
retain labeled earlier output but invalidate its suggestions. Superseded browser
requests are aborted and cannot append output or replace the current result.

The panel retains at most 400 entries and 12 MiB of text, reports discarded
entries, and follows new output only while the user remains at the bottom.
Public URLs stay fully selectable. Metadata uses the existing
script-free iframe and large-value masks. Backend output buffering and individual
wire records are capped at 96 MiB (including escaped metadata or image data URIs);
ordinary metadata remains capped at 10 MiB. No RPC endpoint credentials,
authorization headers, exception stacks or executable terminal content are sent.

`yarn debug:bootstrap --stream` retains the negotiated output as `.ndjson` beside
the normal read-only live-check artifacts. No bootstrap runs are queued by it.

The inspector treats keys and values as escaped text in the token-detail iframe
boundary: empty sandbox, no referrer, and CSP denying scripts, network access,
forms and base URL changes. Keys/values over 240 characters have expandable masks.
Deep/wide documents use collapsed original text to bound DOM generation.

Queue eligibility depends on the entered address, local slug, image source field,
explicit scope and valid cache settings. Animation is optional. Successful
probing, a sample, metadata, image estimation and OpenSea are optional.
Structural limits, overlap checks and anchored worker ownership checks remain
enforced. Queueing does not promise recovery of unavailable metadata.

**Token scope** offers a range, explicit IDs or **Entire contract** through
ERC721Enumerable at any time after acknowledgement. The range's first ID
(editable default `1`) and token count define `first .. first + count - 1`,
including unminted IDs. Unknown/false Enumerable support produces a warning when
entire-contract mode is selected, not a disabled control.
The suggestion and selected mode both show the detected contract-wide token
count, including all projects on shared contracts. This count is independent of
any entered manual range. Image caching defaults to a 2400 px maximum dimension;
an explicit saved dimension remains unchanged.

Contract discovery also returns nullable `sharedContract` warning evidence.
The RPC adapter recognizes membership in the official Art Blocks mainnet Core
Registry, or compatible project getters with a populated project and consistent
counters. Discovery checks at most one project and does not derive its token
boundaries; the separate inspection operation can suggest the sampled project's
range as described above. Registry addresses and getter interpretation belong to
the family adapter, not collection-specific setup rules. All reads share the
probe's pinned block and final hash verification. No OpenSea or metadata call
participates in this check. Registry/getter failures remain optional check output.
No finding means unknown, not standalone; unrecognized shared-contract families
can remain undetected. A finding warns beside Token scope and suppresses the
whole-contract suggestion, while preserving explicit manual control.

Successful sample ownership can trigger an exact OpenSea lookup even when
metadata fails. The cyan resolve button displays the exact sample token ID used
for the lookup. The association is included only while the effective sample
belongs to the selected scope. A resolved slug replaces the resolve button with
the cyan badge; editing it restores the action. An out-of-scope sample changes
the badge to a yellow `check scope` link and keeps the resolved slug. Correcting
the entered range/list makes it usable without inspecting or resolving again;
queueing before that correction still omits the association. The warning belongs
beside Token scope, not beneath the sample or OpenSea controls.

### Separate API Operations

| Operation            | Route                                                             | Contract                                                                                                                                                             |
| -------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discover contract    | `GET /api/:chain_ref/collections/bootstrap/probe?address=...`     | Independent interface, supply, proxy, name and token candidates at one finalized block.                                                                              |
| Inspect sample       | `POST /api/:chain_ref/collections/bootstrap/sample`               | Address, optional requested/discovered ID, observation and declared scope; returns ownership, project range facts, URI, bounded text and scope-specific cache hints. |
| Measure cached image | `POST /api/:chain_ref/collections/bootstrap/image-cache-estimate` | Image, sample ID and cache settings; returns a per-image measurement, without a collection count.                                                                    |
| Resolve OpenSea      | Existing `opensea-slug-probe` GET                                 | Exact address/sample and optional slug.                                                                                                                              |
| Queue bootstrap      | `POST /api/:chain_ref/collections/bootstrap`                      | Explicit `scope`, slug, media fields, cache settings and optional verified OpenSea association.                                                                      |

`scope` is exactly one of:

- `{mode: "enumerable"}`
- `{mode: "manual_range", startTokenId: "1", tokenCount: 3333}`
- `{mode: "manual_token_ids", tokenIds: ["1", "42"]}`

Token IDs are decimal uint256 values, normalized and deduplicated where applicable.
The shared owner validates range end, count and list limits. No collection scope
storage migration is needed; create maps the explicit scope to the existing
worker representation.

This is a coordinated API migration. The old `firstToken`, probe-wide `ready`,
`suggestedInput`, and create `supportsEnumerable/manualInput` fields are removed.
Deploy backend, frontend and CLI together. POST inspection uses the normal
host/origin/CSRF checks despite making no persistent changes.
The [OpenAPI document](../backend/openapi.yaml) defines the complete wire contract.

### Edits and Reuse

- Address or chain edits discard all findings. Removing acknowledgement also
  invalidates pending operations while preserving the entered definition.
- Sample edits discard sample-dependent results, retaining contract findings.
- Image/animation field edits re-evaluate the retained JSON locally through the
  shared metadata selectors. Only image-field edits invalidate image measurements.
- Range/list/count edits retain the inspected sample and measured image.
  Membership and totals are recalculated locally. An outside sample remains
  inspectable, but provides no collection estimate or attached OpenSea slug.
- Image settings invalidate their measurement. Changing only the count reuses
  measured bytes and recalculates the total without downloading the image again.
- Late responses cannot replace newer identity, sample, image or OpenSea state.

### Scope Is Not Minted Inventory

The user selects the intended collection universe; the probe does not discover
that universe by walking tokens. Keep these facts separate:

- `totalSupply()` is not a generic maximum token ID or published mint cap.
  Outside Enumerable mode, it may be a partial or contract-specific counter;
  combining it with one existing token cannot prove a contiguous range.
- A shared contract can genuinely implement ERC721Enumerable while its global
  indexes interleave several projects. A successful address-only sample and
  contract-wide supply do not identify which project the user wants.
- The editable first-token default of `1` is a convention, not a discovered
  boundary. A missing low ID may be unminted, burned, or not yet migrated. Do not
  shift the requested range to the first token that happens to have an owner.
- Explicit token IDs are the fallback when a collection cannot be represented
  by a reasonable bounded interval. The form warns when a sample is outside the
  selected range/list and omits its OpenSea slug when queueing; the declared
  bootstrap scope remains valid in the form and CLI. An explicitly requested
  OpenSea attachment requires an in-scope sample. Run creation separately
  validates the scope and rejects overlap with existing collections.

Manual form submission does not require successful sample/metadata checks. It
does not bypass range limits or turn worker RPC failures into absent tokens, and
it adds no collection-specific heuristics to the generic probe. See the [regression cases](11-testing.md#bootstrap-regression-cases)
for shared-contract and partially minted examples.

### Probe Data Sources and Guarantees

All related chain reads carry a block number and hash. Discovery selects a
finalized block, and dependent inspection verifies the supplied observation before
and after its reads. A changed block fails the operation rather than combining
facts from different chain states.

| Question                                      | Source                                                                            | Meaning                                                                                       |
| --------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Contract capabilities, proxy, name and supply | Pinned bytecode/storage and independent ABI reads                                 | Contract-level facts, not shared-project identity or a mint cap.                              |
| Discovery candidates                          | `tokenByIndex(0)` when supported; independent ownership checks of 0/1             | Bounded candidates. Enumeration order is not numeric order.                                   |
| Automatic sample within a declared scope      | At most four range/list ownership candidates, then an optional discovery fallback | An inspection example only; no range scan or boundary inference.                              |
| Explicit sample existence                     | `ownerOf(sample)` before metadata                                                 | Owned, proven absent or unknown at the observed block. URI success is not ownership evidence. |
| Metadata and selected fields                  | Pinned `tokenURI(sample)`, then bounded inline/HTTP/IPFS text                     | Sample display data. Shared selectors run locally over retained JSON.                         |
| Cached-image measurement                      | Explicit estimate through the worker's image processor                            | Per-image bytes/dimensions; totals use the current declared count.                            |
| Scope                                         | User input and shared validation                                                  | Declared coverage; the worker later determines its present subset.                            |
| OpenSea identity                              | One exact NFT lookup                                                              | Association of that sample with a slug, not verification of the whole scope.                  |

No preflight path reads historical events, scans arbitrary ranges or paginates
marketplace inventory. A discovered sample outside the selected scope may be
inspected, but is excluded from collection estimates and OpenSea attachment.

The OpenSea adapter currently requests
`GET /api/v2/chain/ethereum/contract/{address}/nfts/{sample_token_id}` with its
configured API key and reads `nft.collection`. A staged slug is normalized and
must match; an empty slug can be filled by the explicit lookup. One logical
lookup may retry the same NFT under the shared HTTP policy, but never expands
to other token IDs, a contract-only fallback, collection-details verification,
or first/last boundary checks. A missing sample in OpenSea does not prove the
requested range is invalid.

The local collection slug is an independent ArtGod identifier. Its **apply "value"**
button explicitly accepts a slug from the contract name, including replacing an
existing draft. That name may identify the shared contract rather than the intended
project. Review it before queueing. Editing a sample,
metadata source, address, or OpenSea slug invalidates the relevant old result;
it does not submit a new request or let a stale response replace the draft.

The sample is preflight input, not persisted bootstrap identity. Current sample
ownership does not prove ownership at the older safe anchor. Bootstrap requires
a nonempty present subset of the configured scope at that anchor, not presence
of the exact preview sample. Existing collections need no scope migration;
OpenSea callers must send `sample_token_id` to the exact-NFT probe.

### Metadata and Image Failure Recovery

Sample ownership is independent of metadata availability. A confirmed owner keeps
the sample marked **owner confirmed** when metadata download or parsing fails;
the form shows that failure beside **inspect** and allows queueing a complete definition.
It must not label
an owned token incorrect merely because its metadata host returned HTTP 429/404,
timed out, or returned unreadable metadata. Contract and supply diagnostics remain
available, and the entered sample, scope, and source fields remain intact.

Expected image download/processing failures return HTTP 502 with a safe recovery
message; upstream status codes remain visible, while raw error details go to logs.
A failed image-cache estimate can be retried with **estimate**. Changing the sample,
image source or cache settings invalidates the old estimate and ignores stale
responses. Scope edits preserve the measurement and recalculate totals only while
the sample remains inside the scope. Caching can remain enabled when an estimate fails or was
never run. Estimate failures do not change the submitted cache policy. Switching
**Image cache mode** to **off** disables local image caching.

For IPFS download failures, check `COMMON_IPFS_GATEWAY_ORIGIN` in Admin config,
restart infra after changing it, and repeat **inspect**/**estimate**. Metadata and image
objects may have different availability even through the same gateway. Use a
gateway that serves HTTP clients; a successful browser view alone does not prove
backend access. No gateway is switched automatically. Both operations use the existing configured
HTTP retry policy, including retriable 429/server/transport failures. A manual retry
starts another operation through that same policy; there is no feature-local loop.

## Current Lifecycle

Collections normally start outside the indexed set. When the user adds a new
collection, or starts bootstrap from a prepared row, the bootstrap worker runs a
deterministic pipeline.

### 1. Register collection

- persist collection config in `collections`
- set `status = bootstrapping`
- create a bootstrap run
- enqueue `bootstrap.collection.start`

### 2. Pick anchor block

- choose `head - reorgDepth`
- persist `bootstrap_anchor_block`
- this block becomes the ownership truth point for snapshotting

### 3. Auto-install embedded collection extension

During bootstrap run creation, the system checks whether the requested collection contract plus token scope exactly matches a known embedded extension definition. If it does, the run stores the requested extension key. During bootstrap start, the worker installs that requested extension onto the resolved `collection_id`.

If it does:

- bootstrap upserts a `collection_extension_installs` row
- the install is DB-activated immediately
- the later collection-extension step can seed and publish artifact work after
  the metadata snapshot settles

Current v1 limits:

- bootstrap only auto-installs build-bundled embedded extensions
- one extension install per collection

### 4. Metadata snapshot

- resolve the selected scope at the anchor: Enumerable mode uses totalSupply
  and tokenByIndex; manual ranges/lists check ownerOf for each candidate
- manual ranges are iterated lazily; only IDs with confirmed nonzero ownership
  receive metadata tasks, while the complete configured scope remains persisted
  for future mint routing
- recognized decoded nonexistent-token reverts are skipped; unknown reverts,
  invalid owners, provider errors, and missing archive state remain failures
  handled by RPC resilience or explicit step retry
- an empty anchor snapshot fails visibly; no event-history or marketplace
  inventory discovery is performed
- fetch/store metadata first
- this step runs before OpenSea offchain work so local token/attribute context exists
- bootstrap metadata writes do not publish per-token extension work; the later
  collection-extension step seeds and publishes artifact tasks after the
  metadata snapshot settles
- metadata snapshot completion enqueues a canonical metadata stats checkpoint so the token browser can use standard traits before extension artifacts converge

### 5. Token image cache

When the bootstrap request enables image caching, the worker seeds a dedicated cache task for each successful metadata row with a non-empty `token_metadata.image`.

The bootstrap probe selects the metadata field that should populate canonical
`token_metadata.image`. It prefers `image`, `image_url`, `image_data`, and
`svg_image_data`, then falls back to image-like metadata fields or values. The
created run persists the selected field in `request_image_source_field`, and
bootstrap metadata fetching uses that field when normalizing each token.

The probe can also accept an explicit sample token id. This changes only the
representative ownerOf/tokenURI reads used by the pre-bootstrap form for preview,
storage estimates, and optional OpenSea identity. It is not persisted to the bootstrap run and does not change
the collection token scope or later metadata enumeration.

When the probed contract is a recognized deterministic proxy, the probe response
includes the implementation address for operator visibility. Supported proxy
patterns are EIP-1167 minimal proxies and ERC-1967 implementation or beacon
proxies. The metadata, supply, ownership, and token reads still execute against
the collection contract address so proxy storage and immutable clone context
remain intact.

The probe also selects the optional metadata field that should populate
canonical `token_metadata.animation_url`. It prefers `animation_url`,
`animationUrl`, `generator_url`, and `generatorUrl`. A bootstrap run persists
the selected field in `request_animation_source_field`; `NULL` means bootstrap
metadata fetching intentionally skips animation capture for the collection.

- image-cache work is published to the `collection-bootstrap-image-cache` queue
- the main bootstrap path continues to ownership/backfill/live without waiting
  for image-cache completion
- bootstrap run detail keeps image-cache progress visible from the
  `bootstrap_run_steps` journal and task counts while work is still retained
- the cache uses canonical `image`, not `animation_url`
- IPFS image refs are resolved through `COMMON_IPFS_GATEWAY_ORIGIN`
- metadata and image HTTP fetches use shared `COMMON_HTTP_FETCH_*` timeout and
  bounded retry settings
- files are written under `COMMON_MEDIA_CACHE_DIR`, or beside the SQLite DB when unset
- a configured max dimension resizes images into WebP through `sharp`
- a null max dimension stores original source bytes when possible
- failed images retry under the bootstrap retry policy and then become `failed_terminal`

The collection can continue even when some image cache tasks fail terminally. The cache is a local presentation optimization, not metadata truth.

### Collection Extension Shadow Path

Collection extensions intentionally run behind the canonical metadata snapshot rather than replacing it.

Current behavior:

- bootstrap metadata writes `token_metadata` and normalized attributes first
- bootstrap metadata snapshot completion releases canonical trait stats through the queue outbox
- extension artifact refresh is queued afterward on the dedicated collection-extension queue
- Terraforms may add extension-owned synthetic unminted-placement artifact tasks to that same queue after canonical metadata tasks are available
- metadata-derived and extension-owned collection-extension artifact tasks are seeded together in one SQLite transaction
- bootstrap extension artifact task rows are the concurrency boundary: workers
  claim pending/retry rows with a persisted lease, renew the lease while
  rendering/fetching, and only the current lease owner can settle success,
  retry, or terminal failure
- bootstrap does not wait for extension artifact completion before moving to image cache, ownership snapshot, or later phases
- extension artifact terminality releases a final stats recompute that includes extension-owned normalized traits

This ordering is important because:

- `token_extension_artifacts` references `tokens` rows; normal minted refresh uses canonical rows, while unminted publication creates extension-synthetic rows
- extension-owned synthetic token rows are published with `record_kind = "extension_synthetic"` atomically with their artifact and trait writes
- retired synthetic identities are tombstoned so delayed bootstrap tasks cannot recreate them after a real mint refresh
- extension logic can depend on normalized attributes already written by the canonical metadata path
- canonical ownership correctness must not be blocked by collection-specific extras

The first embedded extension, Terraforms, uses this shadow path to cache version-2 renderer artifacts, add browseable unminted placement rows, and later drive backend media overrides.

### 6. Ownership snapshot

- seed one ownership task per token after metadata completes
- each task calls `ownerOf(tokenId)` at the anchor block through the shared
  resilient bootstrap RPC lane (manual-scope ownership is currently re-read after
  enumeration rather than cached across steps)
- successful tasks persist snapshot rows
- task retries use the bootstrap retry policy
- ownership is mandatory: terminal ownership task failures fail the bootstrap
  run and block collection liveness
- once all ownership tasks succeed, snapshot rows finalize the base
  `nft_balances` state

### 7. Schedule short backfill

- enqueue short backfill from `anchor + 1` to current head
- bootstrap later checks block coverage before finishing the onchain bootstrap run
- the short backfill is collection-scoped
- this range is intentionally post-anchor so it can safely advance current-state tables

### 8. Schedule OpenSea bootstrap

After local metadata + ownership are available, bootstrap enqueues an OpenSea bootstrap job only when OpenSea integration is enabled and the collection has an explicit OpenSea slug.

When enabled, that OpenSea flow does:

1. read the persisted `collections.opensea_slug`
2. mark OpenSea lifecycle state pending/running for that collection
3. start the initial OpenSea orderbook snapshot
4. let the stream worker independently subscribe while the collection is
   bootstrapping once the slug, non-null OpenSea status, and enabled
   stream-ingestion state are visible

This OpenSea work runs in parallel with the short onchain backfill.

When OpenSea is disabled (`OPENSEA_INTEGRATION_MODE=disabled` or `auto` with no `OPENSEA_API_KEY`), bootstrap records an `opensea.skipped` run event and does not mark collection OpenSea state pending. When OpenSea is enabled but no slug was configured, bootstrap also records `opensea.skipped` and continues onchain bootstrap without OpenSea work.

If a collection becomes `live` without OpenSea readiness, the collections table
exposes `start opensea sync`, including for a missing persisted slug. The modal
performs no lookup until **resolve** is pressed. The backend selects one token
with positive canonical local ownership and uses that exact contract/token in
the NFT lookup. It never uses the first/last range boundaries. If no owned token
is locally available, resolution reports that ownership sync must complete.
Starting sync repeats single-sample verification before storing the slug,
marking OpenSea state `pending`, and enqueueing an `opensea-bootstrap` job
without a bootstrap-run context. No historical bootstrap run is rewritten.

This modal depends on the loaded backend OpenSea integration capability, not
on an OpenSea stream heartbeat. If capability has not loaded during startup,
the disabled input explains that setup status is unavailable. A disabled
integration reports its configuration reason. Neither state proves the slug
is incorrect; missing local ownership is a separate resolution error.

### 9. Mark collection `live`

When the short backfill is complete, the bootstrap worker marks the collection `status = live`.

This means:

- local ownership state is ready
- realtime onchain sync should include the collection

It does **not** mean OpenSea is necessarily ready yet.

It also does **not** mean collection-extension artifact refresh has fully converged yet. Extension artifacts are eventual side-effects and do not gate collection liveness.

### 10. Mark OpenSea offchain `ready`

The OpenSea bootstrap worker marks the collection OpenSea state `ready` after the first full snapshot succeeds.

This is tracked separately via:

- `opensea_status`
- `opensea_ready_at`
- snapshot/reconcile timestamps
- stream subscription-poll and event timestamps; `opensea_last_stream_healthy_at`
  is updated during subscription refresh and on received events, not by an
  explicit SDK connection heartbeat

## OpenSea Reconcile Behavior

After the initial snapshot:

- live stream updates continue through the stream worker
- periodic reconcile keeps the local source-active set from drifting if stream events were missed
- reconcile scheduler also triggers an immediate run on startup for collections whose OpenSea state is stale

Current defaults:

- periodic reconcile: every 15 minutes
- stale-start threshold: 30 minutes

These are config-driven, not hardcoded business invariants.

The collections table's **OpenSea snapshot** column selects
`opensea_reconcile_completed_at`, falling back to
`opensea_snapshot_completed_at` only when no reconciliation has completed.
The API serializes this value explicitly as UTC. Starting, scheduling, or
retrying a reconciliation and receiving stream events do not advance it.
Clicking the timestamp switches relative/absolute display; reload the page to
fetch a newer completion because the table does not poll collection data.
Completion has the [queue-publication meaning](#eventual-consistency-note)
described below, not a guarantee that downstream order validation has drained.

## Correctness Guarantees

### Onchain guarantee

A collection should be considered ownership-correct once:

- metadata snapshot completed
- ownership snapshot completed
- short backfill completed
- `collections.status = live`

Token image cache completion is not part of onchain ownership correctness. It is
a local token-card loading optimization and may continue after the collection is
already live.

After a run completes, cleanup trims succeeded task rows lane by lane once that
lane has no pending or retry rows. Ownership snapshot rows are removed only when
ownership has no terminal failures, and metadata success rows for an extension
run wait until extension artifact tasks are terminal. Terminal failure rows
remain inspectable. `bootstrap_run_steps` remains the historical journal for
step timing and progress totals.

Manual historical backfill before `bootstrap_anchor_block` does not improve or change current ownership correctness. It only enriches historical facts before the anchor.

### OpenSea guarantee

A collection should be considered OpenSea-ready once:

- an explicit OpenSea slug was provided and persisted
- OpenSea integration is enabled
- initial snapshot succeeded
- `collections.opensea_ready_at` is non-null

`opensea_ready_at` is the durable record that initial setup succeeded.
`opensea_status` describes the current bootstrap or reconciliation activity and
may temporarily become `retrying` after readiness. Stale subscription/event
timestamps and reconciliation failures do not clear durable OpenSea readiness;
reconcile is the recovery path.

If OpenSea integration is disabled, there is no OpenSea-ready target for bootstrap. The collection can still become onchain-live, and run-detail polling treats the OpenSea steps as out of scope.

## Eventual Consistency Note

OpenSea snapshot/reconcile completion is currently queue-publication completion, not a guarantee that every published order has already completed downstream validation.

That tradeoff is intentional for now:

- source-complete data is published quickly
- canonical order rows and validation converge through the queue pipeline shortly after

Bootstrap metadata stats follow the same availability-first shape: once
metadata task counts satisfy the snapshot mode, bootstrap records the canonical
stats follow-up and queue-outbox intent; the outbox drainer publishes it.
Extension-owned trait stats converge after the extension side lane finishes.

## Relevant Tables

Bootstrap and OpenSea lifecycle state is tracked primarily in:

- `collections`
- `collection_extension_installs`
- `bootstrap_runs`
- `bootstrap_run_steps`
- `bootstrap_metadata_snapshot_tasks`
- `bootstrap_ownership_snapshot_tasks`
- `nft_balance_snapshots`
- `bootstrap_image_cache_tasks`
- `bootstrap_collection_extension_artifact_tasks`
- `token_image_cache`
- `token_extension_artifacts`
- `opensea_orderbook_runs`
- `offchain_order_observations`

## Relevant Queues and Workers

Queues:

- `collection-bootstrap`
- `collection-bootstrap-image-cache`
- `events-sync-backfill`
- `token-image-cache`
- `collection-extension-artifacts`
- `opensea-bootstrap`
- `opensea-reconcile`
- `offchain-orders-raw`

Workers:

- `bootstrap-worker`
- `sync-worker`
- `collection-extension-worker`
- `opensea-bootstrap-worker`
- `opensea-stream-worker`
- `opensea-reconcile-worker`
- `opensea-reconcile-scheduler-worker`
- `offchain-ingest-worker`
- `domain-worker`

In desktop composition, OpenSea workers are staged but not launched when the resolved OpenSea capability is disabled. In standalone dev, starting an OpenSea worker directly still fails fast unless OpenSea integration is enabled.

## Operator Controls and Recovery

Admin creates and inspects durable runs through the backend bootstrap routes.
The run detail exposes each planned step, persisted progress, whether it blocks
collection liveness, and the actions valid for its current state.

- metadata, ownership, and image-cache processing steps can be paused and
  resumed where the shared bootstrap contract marks them pausable;
- a terminal failed step must be explicitly retried, not resumed;
- run-level `retry-failed` is metadata-specific: it requeues eligible terminal
  metadata tasks and, when image caching is configured, resets the image-cache
  step and removes its old tasks so they can be regenerated; other terminal
  step failures use explicit step-level retry;
- startup and lane polling can wake a ready persisted step after a process
  restart, so recovery does not depend on the original queue delivery;
- strict metadata failure blocks liveness; best-effort metadata can complete
  with retained terminal failures; ownership failure always blocks liveness;
- image-cache and extension-artifact side lanes may fail without rolling back
  canonical metadata or ownership.
- completed-run history remains the current place to inspect terminal
  non-blocking side-lane failures; whether those failures also warrant a
  persistent warning on the collection outside bootstrap history remains a
  product decision.

## Current Limits and Future Direction

- Enumerable discovery and manual-scope ownership filtering still execute in
  one step and collect present IDs before seeding tasks. Very large collections
  would benefit from persisted enumeration pages. Manual owners are read again
  by the later ownership step; reuse or phase consolidation remains deferred
  under `BKL-037` in the [unified backlog](../planning/01-unified-backlog.md).
- Enumeration is marked succeeded before metadata task batches are fully
  seeded. A process exit in that gap can leave a terminal enumeration step with
  an empty or partial metadata task set; the restart path does not currently
  prove that seeding reached the enumerated total.
- Ownership tasks are durable and retryable but processed serially. A bounded
  pool inside the owning step and independent task workers are different
  scaling choices; either must preserve exclusive task ownership and finalize
  the snapshot only after every required ownership task succeeds. See
  [execution and concurrency](17-bootstrap-execution-and-concurrency.md#9-ownership-snapshot).
- OpenSea bootstrap is one collection snapshot at a time. Collection-level
  concurrency needs fenced source-state reconciliation and shared API limits.
- Successful operational tasks and ownership snapshots are cleaned only after
  the run is completed and their lanes settle; terminal failure rows and run
  events remain available for inspection and redrive.
