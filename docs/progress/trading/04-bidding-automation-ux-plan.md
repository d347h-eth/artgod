# Bidding Automation UX Plan

Status: WIP plan
Branch: `feature/bidding-automation-ux`

This document plans the next bidding UX layer on top of the current DB-backed bidding jobs and bid-book display.

The current runtime contract remains unchanged: SQLite stores declared desired job state, the bidding bot owns market-side effects, and the bot's OpenSea snapshot remains the competitive source for bidding decisions.

## Goals

- Let users curate wanted tokens and token sets from the existing asks, offers, and tokens exploration surfaces.
- Let users create or adjust bidding jobs from contextual market evidence, especially existing bid-book rows.
- Replace static token bidding forms with a shared bottom-right bidding automation panel.
- Make the bid-book page the primary surface for offer display, own-bid monitoring, and job adjustment.
- Add collection-level price tiers so many jobs can inherit pricing from a small editable strategy graph.
- Keep the first implementation incremental and compatible with the existing token-scoped job runtime.

## Non-Goals

- Do not rewrite the battle-tested bidding runtime business logic.
- Do not make canonical `orders` rows a bidding decision source.
- Do not immediately remove the existing jobs page before the replacement flow is operational.
- Do not introduce sniping UI or pricing behavior in this pass.
- Do not build a full token-card tier management board in the first slice.

## UX Model

The user should be able to start a bidding action from three sources:

1. Filtered token selection:
   - User filters a collection through existing trait/token controls.
   - User clicks `select all tokens` for the current filter.
   - The selection records the filter snapshot and targets all matching tokens across the collection, not only the visible page.
2. Explicit token selection:
   - User toggles individual token cards in asks, offers, or tokens exploration.
   - This can add to or subtract from a filter-based selection.
   - Supported gestures should be `Ctrl` + left click and/or middle mouse click on the token card area.
   - Gesture handling must be isolated behind token-card selection props so generic card behavior stays reusable.
3. Selected bid:
    - User acts on an existing bid-book row.
    - The draft inherits target scope, maker-independent bid parameters, current price context, and visible market scope from that row.

Any of these actions opens the same bottom-right bidding automation panel.
The panel owns job creation/update controls for the selected target and can be reused from token detail, collection offers, asks, and tokens views.

## Selection Domain

The key distinction is:

- selection: temporary UI intent about what the user wants to bid on
- draft: editable bidding action prepared from a selection or bid row
- declared job: durable DB state consumed by the bot
- runtime state: bot-owned observed/applied market state

Selection state should be route-local or collection-local UI state, not persisted job state.
It should be represented with explicit typed sources instead of loose page state.

Suggested selection source union:

```ts
type BiddingSelectionSource =
    | {
          type: "filtered_tokens";
          traitFilters: TraitFilterSnapshot;
          tokenStatus?: string;
          tokenCount: number;
      }
    | {
          type: "explicit_tokens";
          tokenIds: string[];
      }
    | {
          type: "selected_bid";
          bid: BidBookRowSelection;
      };
```

The first implementation must not require every selected token ID to be held in frontend memory for large filtered sets.
For clean filter-based selections, the backend resolves the filter snapshot at submit time so all matching collection tokens across all pages are included.
If the user starts manually unselecting tokens after a filter selection, the first pass may downgrade that draft to the currently visible token IDs only.

## Automation Panel

The shared panel should be a compact bottom-right surface with:

- target summary: token, token count, trait criteria, bid scope, or selected bid context
- pricing mode: manual scalar prices or collection tier
- floor, ceiling, and delta preview in Ether units
- current market context when available: top bid, user's active bid, ask floor, and winning/outbid state
- submit action for create/update
- archive/disable action when editing an existing job

The panel should not contain instructional prose.
It should use compact labels and existing control families.

The panel should be opened by:

- `select all tokens` from token exploration
- token-card selection gestures
- bid-book row action
- token detail bid-book action

The existing static `TokenBiddingJobForm` should be removed only after the shared panel can fully create, update, and archive token-scoped jobs.

## Bid Book Integration

The bid book should become the primary bidding operations surface.

Near the scope controls, add a `show my bids` action once the backend can expose the relevant bidding wallet address.
This should apply the existing maker filter with the user's bidding address, not invent a separate filter path.

Own bid rows should eventually display:

- own bid marker: visual highlight plus a compact icon or label
- market position: winning, draw, or losing
- strategy constraint state: ceiling hit, floor hit, balance limited, or allowance limited
- direct edit action that opens the automation panel with the associated job context

Current limitation:

- `isOwn` is reliable for bot snapshot rows when the bot knows the maker address.
- Orders fallback cannot always know the user's bidding address until the backend/runtime exposes assigned bidding wallet state.

## Price Tiers

Price tiers are collection-scoped reusable pricing definitions.
Jobs can reference a tier, but the bot still receives finalized scalar floor/ceiling/delta values.

Core rules:

- A collection can have multiple root tiers.
- A tier can have one parent.
- A tier can have at most one active child.
- Tier resolution must detect cycles and invalid parent references.
- Each tier stores the original pricing configuration and the latest resolved scalar values.
- Human-facing inputs and displays use Ether units.
- Persisted resolved amounts use wei strings.

### Tier Price Components

Each tier has separate floor and ceiling definitions.

Floor definition options:

```ts
type TierFloorConfig =
    | { kind: "fixed"; valueEth: string }
    | { kind: "parent_delta"; deltaKind: "absolute"; deltaEth: string }
    | { kind: "parent_delta"; deltaKind: "percent"; percent: string };
```

Ceiling definition options:

```ts
type TierCeilingConfig =
    | { kind: "fixed"; valueEth: string }
    | { kind: "floor_delta"; deltaKind: "absolute"; deltaEth: string }
    | { kind: "floor_delta"; deltaKind: "percent"; percent: string }
    | { kind: "parent_delta"; deltaKind: "absolute"; deltaEth: string }
    | { kind: "parent_delta"; deltaKind: "percent"; percent: string };
```

This keeps the common flow simple:

- root tier floor can be a fixed scalar, such as current collection floor entered by the user
- root tier ceiling can be a fixed scalar or a delta from that tier's floor
- child tiers can derive from parent resolved values by absolute or percentage deltas

Root tiers are user-entered scalar values in the first pass.
External dynamic anchors, such as live ask floor or current collection bid, can be added later as separate config kinds.
Do not overload fixed scalar tiers to mean live market anchors.

### Suggested Tier Schema

```sql
CREATE TABLE trading_bidding_price_tiers (
  tier_id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  parent_tier_id TEXT,
  floor_config_json TEXT NOT NULL,
  ceiling_config_json TEXT NOT NULL,
  resolved_floor_wei TEXT,
  resolved_ceiling_wei TEXT,
  resolved_at TEXT,
  last_error TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  archived_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY(collection_id) REFERENCES collections(collection_id),
  FOREIGN KEY(parent_tier_id) REFERENCES trading_bidding_price_tiers(tier_id),
  CHECK (status IN ('enabled', 'paused', 'archived'))
);
```

Useful indexes:

```sql
CREATE INDEX trading_bidding_price_tiers_collection_idx
  ON trading_bidding_price_tiers (chain_id, collection_id, status, sort_order);

CREATE UNIQUE INDEX trading_bidding_price_tiers_one_child_uq
  ON trading_bidding_price_tiers (parent_tier_id)
  WHERE parent_tier_id IS NOT NULL AND status != 'archived';
```

The one-child invariant is enforced by the unique partial index.
Multiple root tiers are allowed because `parent_tier_id IS NULL` rows do not participate in that unique index.

### Job Pricing Link

Keep current scalar runtime fields in `trading_bidding_job_specs`:

- `floor_wei`
- `ceiling_wei`
- `delta_wei`

Add nullable pricing metadata:

- `price_tier_id`
- `pricing_source_json`

The scalar fields remain the bot-facing contract.
The metadata lets backend/UI explain whether the scalar values came from manual input or a tier snapshot.

Tier changes do not automatically mutate existing jobs in the first pass.
The user should get a staged preview of affected tier-backed job changes and explicitly apply the update before new job commands are emitted.

## Target Strategy

The first pass should support two write paths:

- clean trait-filter selections become trait bidding jobs
- explicit or manually adjusted token selections become token jobs

For selected tokens:

- batch create/update token jobs when the selection is explicit or manually adjusted after a filter selection
- preserve selection attribution in job metadata or command payload for UI explanation
- do not require the bot to understand a new token-set target yet

For selected bids:

- token bid rows can create token jobs
- trait bid rows can initially prefill a draft, but durable trait job creation should wait until trait/collection target APIs are implemented end to end
- collection bid rows can initially prefill a draft, but collection-scoped creation should remain explicit and guarded

For clean trait-filter selections:

- if the user selects all filtered tokens and does not manually unselect token cards, create a trait bidding job instead of fanning out into token jobs
- if the user filters by traits and then unselects token cards, draft only the visible token IDs in the first pass
- avoid building a throw-away backend path for "all tokens matching this trait set except these arbitrary exclusions" until that target model is explicitly needed

Long-term target expansion:

- add `token_set` as a declared job target if batch token jobs become too noisy
- wire collection job mutation APIs around the existing `target_kind = 'collection'` schema
- keep runtime parser/placement semantics as the authority for what each target kind means

## Backend Shape

Use cases should remain the application core.
HTTP handlers should only map transport DTOs to use-case inputs and outputs.

New or expanded use cases:

- list collection bidding price tiers
- upsert collection bidding price tier
- archive collection bidding price tier
- resolve collection bidding tier graph
- create/update token bidding jobs from a selection
- resolve bidding draft from selected bid row
- expose own bidding wallet identity for maker filtering when available

Mutation rules:

- Job mutations must write desired job state and `trading_job_commands` rows in the same transaction.
- Tier mutations do not directly affect market offers unless jobs are explicitly re-resolved or updated.
- If tier updates should later cascade into jobs, that cascade must produce normal job update commands.

## Frontend Shape

Add reusable pieces instead of page-specific implementations:

- bidding selection controller/store
- token-card selectable state props
- bottom-right bidding automation panel
- tier selector and resolved-price preview
- bid-book row action contract for selected-bid drafts

Token-card selection should be opt-in.
Generic token cards should not import bidding-specific state directly.
The page passes selection props and callbacks into reusable card/grid components.

The asks, offers, and tokens pages should share the same card selection behavior where enabled.
Activities and holders should not accidentally inherit bidding selection behavior.

## Implementation Slices

### Slice 1: Plan, Types, and UI State Contracts

- Add this plan.
- Define frontend/core types for bidding selection and bidding draft intent.
- Identify where token card selection props should attach without changing behavior yet.

Artifacts:

- `frontend/src/lib/bidding-automation.ts`
- `frontend/src/lib/token-card-selection.ts`

### Slice 2: Price Tier Persistence

- Add tier migration and repository contracts.
- Add backend use cases for tier list/upsert/archive.
- Add tests for one-child invariant, cycle rejection, Ether parsing, and resolved scalar output.

Artifacts:

- `database/migrations/026_trading_bidding_price_tiers.sql`
- `shared/types/trading.ts`
- `backend/src/application/use-cases/trading/bidding-price-tier-ports.ts`
- `backend/src/application/use-cases/trading/bidding-price-tiers.ts`
- `backend/src/application/use-cases/trading/list-collection-bidding-price-tiers.ts`
- `backend/src/application/use-cases/trading/upsert-collection-bidding-price-tier.ts`
- `backend/src/application/use-cases/trading/archive-collection-bidding-price-tier.ts`
- `backend/src/infra/trading/sqlite-bidding-price-tiers-repository.ts`

### Slice 3: Selection Controller and Token Card Opt-In

- Add route-local collection bidding selection state.
- Add opt-in token-card selected rendering and toggle callbacks.
- Add `select all filtered tokens` as a draft action, using a filter snapshot.
- Treat clean filter selections as collection-wide filtered intent, not visible-page selection.

Artifacts:

- `frontend/src/lib/bidding-automation-controller.ts`
- `frontend/src/lib/bidding-automation-controller.test.ts`
- `frontend/src/lib/components/TokenCardTile.svelte`
- `frontend/src/lib/components/TokenBrowserView.svelte`
- `frontend/src/lib/components/CollectionBiddingView.svelte`

Current implementation notes:

- Token-card selection is opt-in through reusable `TokenCardTile` / `TokenBrowserView` props.
- The offers token-card view and regular asks/tokens browser both expose `select all tokens` plus `Ctrl` + click / middle-click selection.
- Holders continues to reuse `TokenBrowserView` without passing selection props, so it does not inherit bidding behavior.

### Slice 4: Shared Automation Panel for Token Jobs

- Implement the bottom-right panel for existing token-scoped create/update/archive only.
- Reuse existing token job APIs first.
- Replace the static token detail form only after parity is verified.

Artifacts:

- `frontend/src/lib/components/BiddingAutomationPanel.svelte`
- `frontend/src/lib/components/CollectionDetailView.svelte`
- `frontend/src/routes/[chain_ref]/[collection_ref]/[token_ref]/+page.svelte`

Current implementation notes:

- The shared panel is used from token detail, collection offers, and collection token browsing.
- Token detail still passes the exact token job context; collection-level surfaces pass draft state from selection or bid-book rows.

### Slice 5: Selected Bid Drafts

- Add bid-book row action to open the automation panel.
- Token-scoped bid rows create token-job drafts.
- Trait and collection bid rows can prefill draft state but should not submit unsupported target kinds yet.

Artifacts:

- `frontend/src/lib/bidding-automation.ts`
- `frontend/src/lib/components/BidBookPanel.svelte`
- `frontend/src/lib/components/BiddingAutomationPanel.svelte`
- `frontend/src/lib/components/CollectionBiddingView.svelte`
- `frontend/src/routes/[chain_ref]/[collection_ref]/[token_ref]/+page.svelte`

### Slice 6: Clean Trait Selection Job Mutations

- Add the backend path for trait bidding jobs created from clean trait-filter selections.
- Preserve the exact trait filter snapshot that produced the job.
- Keep manually adjusted selections out of this path.

Artifacts:

- `backend/src/application/use-cases/trading/upsert-trait-bidding-job.ts`
- `backend/src/http/handlers/trading/upsert-trait-bidding-job.ts`
- `backend/src/infra/trading/sqlite-bidding-jobs-repository.ts`
- `frontend/src/lib/backend-api.ts`

### Slice 7: Batch Token Job Mutations

- Add backend batch token job use case.
- Resolve token-job filter selections server-side for all matching collection tokens when the selection is not represented by a trait job.
- Downgrade manually adjusted filtered selections to visible token IDs in the first pass.
- Emit one command per affected job or a clear batch command shape that the runtime reconciliation can process deterministically.

Artifacts:

- `backend/src/application/use-cases/trading/upsert-batch-token-bidding-jobs.ts`
- `backend/src/http/handlers/trading/upsert-batch-token-bidding-jobs.ts`
- `backend/src/infra/trading/sqlite-bidding-jobs-repository.ts`
- `frontend/src/lib/backend-api.ts`

### Slice 8: Own Bid State and Show My Bids

- Expose known bidding maker address from runtime/backend state.
- Make `show my bids` apply the existing maker filter.
- Enrich own bid rows with winning/draw/losing and job constraint state.

Artifacts:

- `backend/src/infra/trading/sqlite-bidding-bid-book-repository.ts`
- `backend/src/application/use-cases/trading/bidding-bid-book.ts`
- `frontend/src/lib/components/BidBookPanel.svelte`
- `frontend/src/lib/components/CollectionBiddingView.svelte`

### Slice 9: Tier-Backed Job Pricing

- Let the automation panel choose a tier.
- Resolve tier values into scalar job specs at submit time.
- Store pricing metadata alongside scalar values.
- Add staged preview plus explicit apply for re-resolving existing tier-backed jobs.

Artifacts:

- `database/migrations/027_trading_bidding_job_pricing_metadata.sql`
- `backend/src/application/use-cases/trading/bidding-job-pricing.ts`
- `backend/src/http/handlers/trading/list-collection-bidding-price-tiers.ts`
- `backend/src/http/handlers/trading/upsert-collection-bidding-price-tier.ts`
- `backend/src/http/handlers/trading/archive-collection-bidding-price-tier.ts`
- `frontend/src/lib/components/BiddingAutomationPanel.svelte`

Current implementation notes:

- Tier APIs are admin-only.
- Job mutations keep `floor_wei`, `ceiling_wei`, and `delta_wei` as the runtime contract.
- Tier-backed submits resolve tier floor/ceiling at submit time and store `price_tier_id` plus `pricing_source_json`.
- The automation panel shows current tier-resolved floor/ceiling before save; applying a changed tier to an existing job remains an explicit user save action.

### Slice 10: Collection Targets

- Add generalized job mutation APIs for collection targets.
- Keep collection target submits explicit and guarded.

Artifacts:

- `backend/src/application/use-cases/trading/upsert-collection-bidding-job.ts`
- `backend/src/http/handlers/trading/upsert-collection-bidding-job.ts`
- `frontend/src/lib/components/BiddingAutomationPanel.svelte`
- `frontend/src/lib/bidding-automation.ts`

Current implementation notes:

- Collection-wide bid drafts submit through an explicit collection-job route.
- Trait bid drafts submit through the existing trait-job route instead of fanning out into token IDs.
- Explicit token batches submit through the batch token route; single-token batches still use the token route.
- Filtered-token drafts are only submittable when the backend can resolve the filter selection directly.

## Resolved Decisions

> Question: Should `select all filtered tokens` immediately mean all matching tokens across the collection, or should the first implementation be limited to loaded token cards with a clear label?
> Answer: `select all filtered tokens` should mean all tokens that matching that filter across all the collection (so if the filtered results is spread across multiple pages, we must include tokens from all these pages - not only visible results).

> Question: Which gesture should toggle individual token selection without conflicting with existing preview/navigation controls?
> Answer: either "hold CTRL + left mouse button click" or "middle mouse button click" (both: on token card area)

> Question: Should a selected trait bid create a trait-scoped job in the first real write pass, or should it first create a curated token batch derived from current matching tokens?
> Answer: if it's a clean/unmodified single/multi trait filtering (meaning: user hit "select all filtered tokens" after filtering and then didn't start to "unselect" token cards), then we should already do the trait bidding job. trying to fan-out this behavior into the "token IDs" funnel would likely create throw-away code or just be very unreasonable. for simplicity of the first pass though: if user filters by trait(s) and then unselects some token cards, then we can only draft the job for visible token IDs on that page (to limit scope on unwrapping this behavior on backend into actual "all tokens on all pages with this trait, except these token IDs").

> Question: What should root dynamic tiers anchor to first: user-entered scalar, current ask floor, current collection bid, or a selectable market metric?
> Answer: for the root tiers the current scope for now is only "user-entered scalar".

> Question: How should tier updates cascade into already-created jobs: manual reapply, automatic re-resolve, or staged preview plus apply?
> Answer: would be probably a dedicated user setting in future to control this behavior, but for now let's keep it manual, user driven/owned. but let's actually do the "staged preview plus apply" from the start, so at least user can assess changes before committing since it can affect funds/deal damage in case of a mistake.

## Verification Plan

- Backend unit tests for tier graph resolution and invalid tier shapes.
- Backend integration tests for job mutation plus Outbox atomicity.
- Frontend component tests for selection rendering and automation panel draft modes.
- Bid-book tests for selected-bid draft actions and own-bid state labels.
- Manual run with a live bidding collection to verify that UI-created token jobs reconcile without bot restart.
