# Bidding Automation UX Plan

Status: First implementation pass complete; remaining operations slices drafted
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

1. Filtered token or trait targeting:
   - User filters a collection through existing trait/token controls.
   - User clicks `bid on traits` when the intended target is the current trait filter.
   - User clicks `bid on tokens` when the intended target is tokens matching the current token-card result set.
   - Token targeting records the filter snapshot and can target all matching tokens across the collection, not only the visible page.
   - Trait targeting records the exact current trait criteria and creates a trait job; do not infer this from generic token selection.
2. Explicit token selection:
   - User toggles individual token cards in asks, offers, or tokens exploration.
   - This can add to or subtract from a filter-based selection.
   - Supported gestures should be `Ctrl` + left click and/or middle mouse click on the token card area.
   - Gesture handling must be isolated behind token-card selection props so generic card behavior stays reusable.
   - Gesture handling must not break browser link affordances: `Ctrl` + click and middle click on actual links still open those links normally, while media/card body selection keeps taking precedence over preview.
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

The panel should be opened or expanded by:

- `bid on traits`, `bid on tokens`, or `place collection bid` from token exploration and offers
- token-card selection gestures
- bid-book trait bucket action
- token detail inline action

The old static `TokenBiddingJobForm` is superseded by the shared panel.
Token detail renders the same panel inline and does not show the floating-panel `hide` control.

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
- trait bid rows can create trait jobs through the collection-job target path
- collection bid rows can create collection jobs through an explicit guarded submit path

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
- The offers token-card view and regular asks/tokens browser both expose `select all` plus `Ctrl` + click / middle-click selection.
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
- Trait and collection bid rows create drafts that submit through the trait and collection job mutation paths.

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

### Slice 11: Selection State Hardening and Shared Controls

- Make active selection the single source of truth for selected-card state, selection summary, and automation-panel draft.
- Avoid latching panel drafts from token-card selection as a side effect; selected bid rows remain their own explicit draft source.
- Add selected-card visual feedback and an inline unselect shortcut.
- Keep `Ctrl` + left click and middle-click as token-card toggle gestures.
- Unify `select all`, `X selected`, and `clear` controls between asks, tokens, and offers.
- Keep only media-mode controls on the far right of token-browser toolbars; bidding selection controls stay left-aligned.

Artifacts:

- `frontend/src/lib/bidding-automation-controller.ts`
- `frontend/src/lib/components/BiddingSelectionControls.svelte`
- `frontend/src/lib/components/TokenCardTile.svelte`
- `frontend/src/lib/components/TokenBrowserView.svelte`
- `frontend/src/lib/components/CollectionBiddingView.svelte`
- `frontend/src/lib/components/CursorPaginationControls.svelte`

Current implementation notes:

- Clean filtered selections still represent all matching tokens across the collection.
- Once a user manually toggles visible token cards, the draft becomes an explicit visible-token batch for this first pass.
- The selected-card `x` control removes a card without requiring the selection modifier key.

## Remaining Work

The next slices should improve bidding operations rather than adding more static CRUD forms.
The bid book and token browser should remain the main surfaces, while the automation panel becomes the common edit/apply surface.

Current baseline entering these slices:

- Targeting controls are explicit, not inferred: `bid on traits`, `bid on tokens`, `place collection bid`, and trait-bucket `bid`.
- `bid on traits` means the current trait filter or trait bucket becomes the declared trait target; do not reintroduce ambiguous `select all` behavior for this path.
- Trait-bucket `bid` must also apply the bucket criteria into the normal trait filter controls so the top action state, the bid book, and the panel all describe the same target.
- `bid on tokens` means token-job creation, with all-pages vs current-page behavior controlled explicitly by the existing button state.
- Do not cycle `bid on tokens` between all-pages and current-page modes when the current result set only has one page.
- Bid scope ordering is `token`, `traits`, `collection`; token scope is the default offers view.
- Token-card selection remains opt-in through `Ctrl` + left click, middle click, and the selected-card unselect affordance.
- Token-card selection gestures must not intercept `Ctrl` + click or middle-click on actual token-card links.
- The automation panel is the single reusable form for floating collection/browser flows and inline token detail flows.
- Floating panel `hide` collapses to the square place-bid affordance and preserves current state; token detail uses the inline variant without `hide`.
- The panel has no status dropdown; users express intent through `create`, `modify`, `activate`, `pause`, and `archive`.
- Ineligible actions must stay disabled/muted.
- State-changing actions except `reset` require the existing two-click arm/confirm interaction; do not replace it with native confirm dialogs.
- `B` toggles the floating bidding panel and `C` clears the current bidding target on pages where the panel exists.
- Token detail pre-fills from the highest applicable bid plus the same minimum-winning-delta calculation used by collection and trait actions.
- Minimum winning delta is based on the bid price order of magnitude, not one percent of the bid: examples are `20 -> 0.1`, `4 -> 0.01`, `0.23 -> 0.001`, `0.05 -> 0.0001`.
- Human-facing prices and logs stay in Ether units; wei remains an internal/runtime boundary detail.

### Slice 12: Job Association and Edit Existing Targets

Status: complete.

- Resolve whether a bid-book row or token selection maps to an existing declared bidding job.
- Normalize target equivalence in one backend/domain helper so token, trait, and collection lookup semantics are not duplicated in the frontend.
- Pass the matching existing job into the automation panel so selected own bids or selected targets edit instead of blindly creating duplicate declared jobs.
- Support archive/disable for trait and collection jobs from the automation panel, not only token jobs.
- Surface job identity and revision in the panel without adding redundant helper prose.
- Keep DB writes and `trading_job_commands` Outbox writes atomic through the existing repository path.
- Reuse the current panel intent buttons and two-click confirmation for all job state mutations.
- Do not infer an editable job from maker address alone; prefer declared target lookup, stored active order metadata, or explicit runtime job association when available.

Expected artifacts:

- `backend/src/application/use-cases/trading/bidding-job-target-lookup.ts`
- `backend/src/infra/trading/sqlite-bidding-jobs-repository.ts`
- `frontend/src/lib/bidding-automation.ts`
- `frontend/src/lib/components/BiddingAutomationPanel.svelte`
- `frontend/src/lib/components/BidBookPanel.svelte`

Current implementation notes:

- Canonical target equivalence lives in shared trading helpers and is reused by the SQLite jobs repository for active job lookup.
- The backend exposes an admin target lookup path so the shared automation panel can resolve token, trait, and collection drafts into existing declared jobs before showing create/modify/archive actions.
- Target-agnostic job archive is available by job id and emits the same durable `job_archived` plus `cancel_active_offer` command pair in the repository transaction.
- The automation panel now looks up an existing job for draft targets, surfaces job id plus revision, and archives any target kind through the shared job-id route.
- Archived jobs are removed from collection-page job state instead of being kept as editable active jobs.
- Later slices should reuse this target lookup instead of adding page-local "does job exist" checks.

### Slice 13: Price Tier Management UI

Status: complete.

- Add a compact collection-scoped tier management surface reachable from bidding operations.
- Let users create, edit, pause, archive, and order tiers.
- Show resolved floor/ceiling values and last resolution errors.
- Preserve the current first-pass rule that root tiers are user-entered scalar values only.
- Keep tier graph validation in backend use cases; frontend only renders previews and submits typed configs.
- Keep the tier UI compact and operational; avoid a separate static CRUD-feeling page if an inline panel/drawer can serve the flow.
- Reuse existing button families, time display helpers, compact `key: value` rows, and the two-click state-change rule for tier pause/archive actions.
- Keep tier selection in `BiddingAutomationPanel.svelte` as a consumer of resolved tier read models; do not make the panel own tier graph logic.
- Use intent actions instead of a status dropdown: create/modify, pause/activate, archive.
- Keep root tier floor configuration fixed-scalar only until explicit dynamic anchors are added.
- Disable or hide parent-derived config options when no parent tier is selected.
- Update the collection-level tier state after mutations so open automation panels immediately see the latest resolved tiers.

Expected artifacts:

- `frontend/src/lib/components/BiddingPriceTierPanel.svelte`
- `frontend/src/lib/components/BiddingPriceTierRow.svelte`
- `backend/src/application/use-cases/trading/upsert-collection-bidding-price-tier.ts`
- `backend/src/application/use-cases/trading/archive-collection-bidding-price-tier.ts`

Current implementation notes:

- Collection offers exposes a compact `tiers` toggle that opens collection-scoped tier management without leaving the bidding operations surface.
- `BiddingPriceTierPanel.svelte` owns tier form state and mutation calls; `BiddingAutomationPanel.svelte` only consumes the updated resolved tier read models.
- The tier panel can create, modify, pause, activate, archive, and reorder active tiers through existing backend graph-validation use cases.
- Root tier floor configuration stays fixed-scalar only; parent-derived floor/ceiling controls are only available when a parent tier is selected.
- Tier pause, activate, archive, create, and modify actions use the same two-click arm/confirm behavior as other bidding state changes.
- Tier mutations update collection-local tier state so open bidding panels see the latest resolved floor/ceiling values immediately.
- Ordering is a first-pass single-tier sort-order move; if tier ordering needs atomic multi-row swaps later, add a backend use case instead of coordinating swaps in the frontend.

### Slice 14: Staged Tier Reapply

Status: complete.

- List existing tier-backed jobs affected by a tier edit.
- Show a staged before/after preview for resolved floor, ceiling, and delta.
- Apply selected staged changes only after explicit user confirmation.
- Emit normal job update commands for every affected job; do not introduce a hidden cascade path.
- Keep automatic cascade as a future user preference, not the default behavior.
- Use the same job mutation path as manual panel edits so the bot sees ordinary desired-state revisions.
- Show affected targets in compact rows/cards with enough context to detect accidental fund-damaging changes before apply.
- Keep preview calculations backend-owned; frontend renders the staged diff and selected apply set.
- Use `price_tier_id` and `pricing_source_json` as metadata for finding affected jobs; the scalar job fields remain the bot contract.
- Do not silently mutate jobs when a tier is paused or archived.
- Apply should use the same two-click arm/confirm interaction as other fund-affecting job state changes.
- Apply only selected job ids from the preview; do not bulk-apply every affected job implicitly.
- Preserve each job's existing runtime status while updating only tier-derived scalar pricing and pricing metadata.
- Disabled/archived jobs must not be resurrected by reapply; archived jobs stay outside the editable reapply set.
- After apply, refresh the collection job read model so open automation panels see the new scalar values immediately.
- Treat unchanged jobs as preview-only rows; applying them should not emit no-op job update commands.

Expected artifacts:

- `backend/src/application/use-cases/trading/preview-bidding-price-tier-reapply.ts`
- `backend/src/application/use-cases/trading/apply-bidding-price-tier-reapply.ts`
- `frontend/src/lib/components/BiddingPriceTierReapplyPreview.svelte`

Current implementation notes:

- Backend preview/apply use cases own tier graph resolution and affected-job calculation; the frontend only renders the staged diff and selected apply set.
- Admin routes are exposed under each collection price tier:
  - `GET /api/:chain_ref/:collection_ref/bidding/price-tiers/:tier_id/reapply-preview`
  - `POST /api/:chain_ref/:collection_ref/bidding/price-tiers/:tier_id/reapply`
- Apply accepts explicit `jobIds`, updates selected changed jobs through the jobs repository, and publishes ordinary bidding job command wake-ups after the transaction commits.
- Repository-level apply keeps the bot-facing scalar job fields canonical and updates `price_tier_id` / `pricing_source_json` as explanatory metadata.
- The tier panel opens a compact preview from each tier row, lets the user select changed jobs, and uses the standard two-click arm/confirm flow for apply.
- Focused backend/frontend tests pass, and the tier panel refreshes collection-local job state after apply so open automation panels see the new scalar values.

### Slice 15: Own-Bid Runtime State and Constraint Signals

Status: complete.

- Enrich own bid rows with job-linked status: winning, draw, losing, ceiling hit, floor hit, balance limited, and allowance limited.
- Add compact icons or labels directly on own bid rows.
- Use the existing maker filter for `my bids`; do not create a separate filtering mechanism.
- Source own maker identity from bot/runtime state when available, and keep orders fallback honest when it cannot know the wallet.
- Keep all bot decision semantics inside the runtime; UI consumes read models only.
- Connect own bid rows to declared jobs where possible so clicking/editing opens the current job rather than only drafting a new target.
- Preserve the current bid-book source language: `refresh pace` is `normal` for orders and `competitive` for bot snapshot projection.
- Keep constraint labels compact and deterministic; no explanatory prose in rows.
- Reuse Slice 12 target lookup or explicit runtime job association; do not infer editability from maker address alone.
- Keep row-level state as a read model. The frontend should not reimplement runtime bidding decisions.

Expected artifacts:

- `backend/src/application/use-cases/trading/bidding-bid-book.ts`
- `backend/src/infra/trading/sqlite-bidding-bid-book-repository.ts`
- `frontend/src/lib/components/BidBookPanel.svelte`

Current implementation notes:

- Bid-book rows now carry backend-owned `ownStatus` for own bids instead of deriving row status in the frontend.
- The repository computes own-bid position by exact bid scope before applying the maker filter, so `my bids` can still show losing/draw/winning against hidden opponents.
- Own bid rows are linked to matching non-archived declared jobs by token, collection, or exact trait target; the row status exposes job id, revision, and job status.
- Floor and ceiling constraint labels are derived from the matching declared job scalar prices.
- `balance` and `allowance` are included in the read-model constraint contract, but they intentionally remain unset until the bidding runtime persists explicit constraint flags. Do not infer them from free-form error strings.
- The frontend only renders `ownStatus` from the API and no longer reimplements bid-row position or floor/ceiling decisions.

### Slice 16: Offer-Filtered Selection Resolution

Status: pending.

- Decide whether offers-page token selections with maker/offer filters should become backend-resolvable filtered batches.
- If yes, add a SQL-backed resolver that uses normalized bid-book/order data instead of frontend-visible cards.
- Preserve the invariant that all-pages token bidding means all matching tokens across all pages.
- Keep visible manual adjustments downgraded to visible token IDs until an explicit exclusion target model exists.
- Do not make canonical orders a bot decision source; this resolver only creates declared UI-selected jobs.
- Treat `bid on tokens` all-pages behavior as the main driver for this resolver; current-page behavior can continue submitting visible token IDs.
- Respect maker filters and trait filters from the offers page when resolving token-offer result sets.
- Keep token-scope offer pagination grouped by token; avoid rebuilding all-pages selection from already-loaded cards.
- Align this slice with the SQL-backed offer pagination plan before changing repository contracts.
- Apply the 10% relevance floor before grouped token pagination so muted/hidden offers do not change selected-token counts.
- Keep source selection inside the repository/use-case boundary: projected snapshot when the collection has enabled jobs and the bot is running, normalized orders otherwise.
- Preserve OR/AND trait join semantics from the offers filter when resolving the all-pages token set.

Expected artifacts:

- `docs/progress/trading/03-sql-backed-offer-pagination-plan.md`
- `backend/src/application/use-cases/trading/upsert-batch-token-bidding-jobs.ts`
- `backend/src/infra/trading/sqlite-bidding-bid-book-repository.ts`

### Slice 17: Bidding Jobs Page Cleanup

Status: pending.

- Reassess whether the dedicated jobs subpage should remain once bid-book operations can create, edit, and archive all target kinds.
- If retained, make it a compact diagnostics/overview page instead of the primary editing surface.
- If removed, preserve any useful runtime counters in the bid-book operations UI.
- Keep token previews reusable; do not fork token-card or activity-token preview components.
- Do not duplicate the automation panel or job mutation forms inside the jobs page.
- If the page remains, use it for auditability: declared jobs, runtime state, command/revision status, and troubleshooting.
- Preserve existing navigation semantics: direct bidding operations live in offers/bid-book and token browsing surfaces.
- Do not duplicate job mutation forms or tier graph editors here; link or open the shared automation/tier surfaces when editing is needed.
- If runtime counters remain useful, keep them as compact horizontal chips consistent with bid-book metadata.

Expected artifacts:

- `frontend/src/lib/components/CollectionBiddingView.svelte`
- `frontend/src/lib/components/CollectionBiddingJobRow.svelte`

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
