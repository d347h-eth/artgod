# Bidding Automation UI E2E Plan

Status: WIP plan
Owner surface: frontend Playwright / UI-level bidding automation

This document tracks the E2E testing surface for the bidding automation UI.
The goal is to lock the settled user interactions in browser-driven tests without depending on OpenSea, the bidding bot runtime, or live marketplace state.

## Goals

- Verify every user-facing bid-placement entry point from the actual UI.
- Keep tests focused on UI intent, draft state, form state, and outgoing API payload shape.
- Use deterministic fixtures for bid books, token cards, jobs, tiers, and collection settings.
- Keep backend/database behavior covered by backend tests instead of duplicating full-stack proof in Playwright.
- Preserve a small attached-app smoke suite for real local wiring and layout regressions.

## Non-Goals

- Do not run the real bidding bot from Playwright.
- Do not hit OpenSea or other external APIs from Playwright.
- Do not prove order placement, WETH approval, cancellation, or bot reconciliation in UI tests.
- Do not make Playwright depend on whichever live collection data happens to be in the local SQLite DB.
- Do not add route-specific test-only copies of bidding business logic.

## Test Architecture

Use two browser-test layers.

### Deterministic UI Harness

Primary coverage should use a fixture-backed frontend harness that renders production components with fixed data.
The harness exists only to feed stable props and capture submitted API calls.

Rules:

- Render production components such as `CollectionDetailView`, `CollectionBiddingView`, `TokenBrowserView`, `BidBookPanel`, and `BiddingAutomationPanel`.
- Do not fork or duplicate bidding selection, draft, pricing, or panel logic in the harness.
- Capture mutation requests at the backend API boundary and assert payloads.
- Stub read data with typed fixtures for chains, collections, token cards, bid books, jobs, tiers, and settings.
- Keep fixture helpers reusable across bidding E2E specs.
- Prefer role/name selectors for user actions; add `data-testid` only where repeated controls cannot be selected unambiguously.

This harness is the right place to emulate UI flows such as modifier-click token selection, scope switching, tier selection, and panel action gating.

### Attached-App Smoke Tests

Attached tests continue to run against an already-started `yarn dev` app.

Use them only for:

- critical layout geometry checks
- hydration/page-reachability checks
- one or two representative real-data interactions

Attached tests are not the authoritative coverage for every bid-placement scenario because they depend on local DB contents.

## Scenario Matrix

### Collection `asks` and `tokens`

| Scenario | Expected draft/API intent |
| --- | --- |
| `bid on traits` with trait filters | trait-scoped job from current trait filters |
| `bid on all tokens` | filtered token batch across the full result set |
| `bid on this page` after all-token selection | explicit token-ID batch for visible cards |
| `Ctrl` + left click card body | explicit token selection toggles on |
| middle click card body | explicit token selection toggles on |
| selection gesture on token-id or price links | browser link behavior wins; token selection does not hijack the link |
| clear bidding target | selected-count, card visuals, and panel draft clear together |

### Offers `bid_scope=token`

| Scenario | Expected draft/API intent |
| --- | --- |
| `bid on traits` | trait-scoped job from current offers trait filters |
| `bid on all tokens` | `TokenOfferFilter` batch using traits, ranges, join mode, and maker filter |
| `bid on this page` | explicit token-ID batch for visible offer cards |
| maker filter active | outgoing `TokenOfferFilter` includes maker address |
| low own token offer | own bids remain visible and selectable despite muted/hide rules |
| token offer card own status | own job/status badge renders on the card |

### Offers `bid_scope=traits`

| Scenario | Expected draft/API intent |
| --- | --- |
| top `bid on traits` | trait-scoped job from current filter criteria |
| top `bid on traits` with OR exploration | drafted trait target stores selected traits as concrete AND job criteria |
| bucket `bid` action | trait-scoped job for that exact bucket, seeded from bucket best bid plus minimal delta |
| bucket filter icon | applies filter only; bidding panel is not opened |
| single-trait bucket | filter icon is hidden; bid action remains available |
| existing own trait intent | panel opens in modify mode with current job values and disabled modify until edited |
| market trait row | panel opens create draft with seeded pricing |

### Offers `bid_scope=collection`

| Scenario | Expected draft/API intent |
| --- | --- |
| `place collection bid` | collection-wide job seeded from top collection bid plus minimal delta |
| collection bid rows | no row-level bid action is rendered |
| existing collection intent | panel opens existing collection job for modify/activate/pause/archive |

### Token Detail

| Scenario | Expected draft/API intent |
| --- | --- |
| `bid on token` | token-scoped job for displayed token |
| token-scoped bid row action | token job/draft for displayed token |
| trait-scoped bid row action | trait job/draft for that row's trait criteria |
| trait table place-bid icon | single-trait job for that token trait |
| collection-scoped bid rows | no place-bid action, including own collection rows |
| inline panel | no floating `hide` control |
| token detail default draft | seeded from highest applicable bid plus minimal delta when no token job exists |

### Automation Panel

| Scenario | Expected behavior |
| --- | --- |
| new target | positive action is `create`; pause/archive muted |
| active existing job | positive action is `modify`; pause/archive enabled when eligible |
| paused existing job | `modify`, `activate`, and `archive` are available by state |
| unchanged existing job | `modify` is disabled until form values change |
| state-changing action | requires double-click confirmation |
| outside click/focus change | clears armed confirmation state |
| manual pricing | floor/ceiling/delta are editable |
| tier pricing | floor/ceiling/delta are visible but not editable |
| switch tier -> manual | last resolved scalar values remain in the inputs |
| `B` key | collapses/expands floating panel |
| `C` key | clears current bidding target |

### Price Tiers Panel

| Scenario | Expected behavior |
| --- | --- |
| `T` key | toggles tier management UI where bidding controls are available |
| tier selector setting | panel uses buttons or dropdown based on collection setting |
| default delta setting | seeds manual empty bidding forms and new tier form delta |
| tier form labels | match bidding panel label/control visual treatment |
| staged reapply | preview and apply flow stays explicit and user-selected |

## Fixture Data Requirements

Create compact fixture sets for:

- collection shell with admin write controls enabled
- public single-collection mode with write controls disabled
- token cards with listed and unlisted states
- token-offer cards with multiple offers, own offers, and muted-low offers
- collection bid-book rows with market rows and own job intent rows
- trait bid-book buckets with single-trait, multi-trait, own-intent, and low-muted rows
- token detail bid book with token, trait, token-set, and collection rows
- active, paused, and archived bidding jobs
- manual and tier-backed pricing
- collection price tiers and collection bidding settings

Fixtures should use small deterministic IDs and addresses.
Amounts in fixture names and assertions should be human-readable Ether values.

## Selector and Instrumentation Rules

- Use accessible roles and names for user-facing actions whenever stable.
- Add `data-testid` for repeated bid-row actions, card selection affordances, and panel action buttons where accessible labels are not unique enough.
- Keep `data-testid` names domain-level, for example `bidding-panel-create`, `bid-book-trait-bucket-bid`, or `token-card-bidding-toggle`.
- Do not assert against volatile class layout internals unless the test is explicitly a layout/geometry test.
- Continue attaching browser console and page errors on failure through the shared E2E diagnostics helper.

## Implementation Slices

### Slice 1: Fixture Harness Foundation

- Add a dedicated fixture-backed Playwright spec entry for bidding automation.
- Add shared fixture builders for collection data, bid books, token cards, jobs, tiers, and settings.
- Add a mutation capture helper that records outgoing bidding API calls.
- Decide whether the harness uses a dedicated frontend-only test route or a minimal component host page.

Acceptance:

- One smoke test can render the offers token-scope page from fixtures.
- One captured mutation can be asserted without a real backend write.

### Slice 2: Token Browser Selection Flows

- Cover `asks` and `tokens` `bid on traits`.
- Cover `bid on all tokens`, `bid on this page`, and explicit token-card toggles.
- Cover link gesture preservation on token-card links.
- Cover unified selected-count/card-visual/panel state clearing.

Acceptance:

- Each token-browser placement action results in the expected draft and mutation payload.

### Slice 3: Token Offer Scope Flows

- Cover `offers?bid_scope=token` filtered token-offer batches.
- Cover maker-filter propagation.
- Cover visible-page refinement and explicit token selection.
- Cover own low bids staying visible and counted where relevant.

Acceptance:

- `TokenOfferFilter` payloads are deterministic and include the expected maker/trait filter data.

### Slice 4: Trait Demand Flows

- Cover top `bid on traits`.
- Cover trait bucket `bid` action.
- Cover bucket filter icon as filter-only.
- Cover single-trait bucket hiding filter action.
- Cover existing own trait intent opening modify mode with unchanged `modify` disabled.

Acceptance:

- Trait target identity and pricing seed behavior are locked in UI tests.

### Slice 5: Collection Scope Flows

- Cover `place collection bid`.
- Cover absence of row-level placement actions on collection rows.
- Cover existing collection job state transitions in the panel.

Acceptance:

- Collection-wide placement remains explicit and cannot be triggered from ordinary rows.

### Slice 6: Token Detail Flows

- Cover `bid on token`.
- Cover token-row and trait-row actions.
- Cover trait table place-bid action.
- Cover collection-row safety rule.
- Cover inline panel without `hide`.

Acceptance:

- Token detail can switch between token and trait job drafts without exposing collection-row placement.

### Slice 7: Automation Panel State Matrix

- Cover create/modify/activate/pause/archive visibility and disabled state.
- Cover double-click confirmation.
- Cover confirmation reset on outside click or focus change.
- Cover manual/tier pricing editability and value retention.
- Cover `B` and `C` keybindings where the floating panel exists.

Acceptance:

- Panel state is locked independently from the page that opened it.

### Slice 8: Price Tier Management UI

- Cover `T` key and `tiers` button.
- Cover tier selector buttons vs dropdown setting.
- Cover default delta setting seeding new bidding forms and tier forms.
- Cover staged reapply preview/apply UI affordances.

Acceptance:

- Price-tier UI behavior is deterministic without needing backend tier mutations to hit SQLite.

### Slice 9: Public Read-Only Mode Guardrails

- Render public single-collection mode fixtures.
- Verify offers and token detail bid books are visible.
- Verify bidding jobs, tiers, and write controls are not visible.

Acceptance:

- Public mode cannot expose local bidding write controls in UI tests.

### Slice 10: Attached Smoke Coverage

- Keep the existing attached bidding panel geometry test.
- Keep one real-data trait bucket bid smoke test.
- Add only one or two additional attached tests if they catch integration drift not covered by fixtures.

Acceptance:

- Attached tests remain small and do not become the main scenario matrix.

## Open Design Questions

- The cleanest deterministic harness shape is still open: dedicated frontend-only route vs component host page.
- Some page components may need small extraction seams to render route data from fixtures without duplicating route loaders.
- The exact `data-testid` naming set should be added only where role/name selectors prove ambiguous.

## Commands

Attached smoke tests require a running local app:

```sh
yarn dev
yarn test:bidding:attached
```

Deterministic fixture tests should eventually have a separate command so they can run without local backend/indexer state.
