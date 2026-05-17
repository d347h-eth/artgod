# Bidding Automation Capabilities

This document is the current-state feature reference for bidding automation UI/UX and its backend API surface.
The implementation plan and historical slice notes remain in `docs/progress/trading/04-bidding-automation-ux-plan.md`.

## Core Invariants

- SQLite is the authoritative declared-state store for bidding jobs, price tiers, collection settings, and durable bot command signals.
- The bidding bot owns marketplace side effects, active-offer cancellation, OpenSea snapshot refreshes, and runtime bid decisions.
- The Userland bidding UI creates or edits declared intent; it never bypasses backend use cases or calls trading adapters directly.
- Bot snapshot projection is a display read model and never replaces the runtime's own authoritative snapshot for bidding decisions.
- `orders` fallback data is passive bid-book display only and never feeds bidder competitiveness or placement decisions.
- Public single-collection mode may expose read-only offers and token bid books, but it must not expose bidding jobs, price tiers, or write controls.
- Amounts shown in UI/API fields use Ether units; persisted EVM-facing amount columns use wei strings.

## User-Facing Surfaces

| Surface | Capability |
| --- | --- |
| `asks` | Token-card browsing with bidding target controls when admin write controls are available. |
| `tokens` | Token-card browsing with the same token/trait bidding target controls as `asks`. |
| `offers` with `bid_scope=token` | Explicit token-scoped offers shown as token cards with ask/bid prices and token-bidding controls. |
| `offers` with `bid_scope=traits` | Trait-demand buckets, trait filtering, maker filtering, and per-bucket bid drafting. |
| `offers` with `bid_scope=collection` | Collection-wide bids and collection-level bid drafting. |
| Token detail | Inline shared bidding panel for the exact token plus the token's applicable bid book. |
| `bidding` jobs page | Read-only declared-job/runtime overview; mutation flows stay in shared bidding surfaces. |

The `offers` page is the primary bidding operations surface.
It combines the bid book, maker filter, bid-scope controls, trait filters where relevant, bidding target controls, tier management, and the floating automation panel.

## Targeting Capabilities

Token targets:

- `bid on all tokens` creates or updates token jobs for every token matching the current filter across the full result set.
- `bid on this page` narrows token-job creation to the currently loaded token cards.
- `Ctrl` + left click or middle click on non-link token-card areas toggles individual selected-token targets.
- Token-card links preserve browser-native `Ctrl` / middle-click new-tab behavior.

Trait targets:

- `bid on traits` creates or updates one trait-scoped collection job from the current trait filter.
- In trait bid-book view, a bucket-level `bid` action applies that bucket's traits to the filter and drafts the same trait target.
- Trait criteria are canonicalized before persistence so the same key/value set resolves to the same declared job regardless of UI order.
- OR-mode filter exploration remains a display/search aid; a drafted trait job stores the selected traits as a concrete AND target.

Collection targets:

- `place collection bid` creates or updates the collection-wide job.
- Collection-wide jobs are represented as collection jobs with empty trait criteria and an explicit quantity.

Existing-job resolution:

- The shared automation panel resolves the draft target before showing actions.
- Existing targets show `modify`, `activate`, `pause`, and `archive` where eligible instead of blindly creating duplicates.
- Token targets resolve by token id.
- Collection targets resolve by collection-wide target identity.
- Trait targets resolve by canonicalized trait criteria and quantity.

## Bidding Automation Panel

The automation panel is the single reusable bidding form surface.
It renders as a floating bottom-right panel on browser-style pages and inline on token detail.

Panel behavior:

- `create` is shown for new targets.
- `modify` is shown for existing targets.
- `activate`, `pause`, and `archive` are enabled only when valid for the current job state.
- All job-state-changing actions except `reset` require a two-click arm/confirm interaction.
- `hide` collapses only the floating panel; token detail does not render a hide control.
- `B` toggles the floating panel where available.
- `C` clears the current bidding target where available.

Panel layout:

- Data rows are compact `label: value` rows.
- Label/input rows use grid-aligned columns.
- Repeated action buttons use stable widths and stable left/right action sections.
- Tier-selected prices remain visible but are not editable; switching back to manual keeps the last resolved values for reuse.

## Price Tiers

Price tiers are collection-scoped reusable pricing definitions.
They resolve to scalar floor, ceiling, and delta values before a job is persisted.

Implemented tier capabilities:

- Root tiers use user-entered scalar floor values.
- Child tiers can derive floor and ceiling from a parent or from the tier floor by absolute or percent delta.
- Each tier owns an explicit delta.
- Tiers can be created, modified, paused, activated, archived, and sorted.
- Tier-backed jobs keep their own scalar values until the user explicitly reapplies a changed tier.
- Staged reapply previews affected jobs and applies only explicitly selected changes.

Collection-scoped bidding settings are stored through the generic `collection_settings` table.
Bidding owns typed setting keys and mapping logic, but persistence remains collection-generic.

Current settings:

- tier selector presentation: fixed-width buttons or dropdown
- default new-tier delta in Ether units

## Bid Book Capabilities

Backend source selection:

- use `bot_snapshot` when the collection has enabled bidding jobs, the bidding bot heartbeat is live, and projection metadata is fresh
- otherwise use `orders`
- standard/admin bid-book reads include own declared-job overlays when the bot has not yet produced or reobserved the matching market bid
- public single-collection mode keeps bid-book reads market-only and never exposes local own-job context

Frontend refresh labels:

- `bot_snapshot` displays as `competitive`
- `orders` displays as `normal`

Bid-book filters:

- `bid_scope=token` shows token-scoped offers as token cards.
- `bid_scope=traits` shows trait/criteria bid buckets.
- `bid_scope=collection` shows collection-wide bids.
- `maker` filters all bid-book representations to one maker address.
- Trait filters support OR and AND join modes where trait bid discovery needs them.

Own-bid display:

- Rows from a live bot runtime can mark the configured bot wallet as `You`.
- Own rows can carry position and job-constraint signals derived from backend/runtime read models.
- Own declared jobs can appear as `own_job_intent` rows with `queued`, `active_order`, or `paused` phase.
- Own-intent rows use range pricing until runtime feedback supplies a single active order price.
- Balance and allowance constraint slots exist in the read-model contract but remain unset until the runtime persists explicit flags.

Orders fallback parser:

- fallback bid-book reads parse raw OpenSea buy-offer payloads through the shared OpenSea bidding-offer parser
- REST raw payload is tried first
- stream raw payload is tried if REST parsing returns no offer
- parser failures are logged and skipped
- there is no legacy fallback scope parser on the bid-book path

## Backend API Surface

Public read endpoints:

| Method | Path | Capability |
| --- | --- | --- |
| `GET` | `/api/:chain_ref/:collection_ref/bidding/bids` | Collection bid book for token, trait, and collection scopes. |
| `GET` | `/api/:chain_ref/:collection_ref/:token_ref/bidding/bids` | Token-applicable bid book across collection, trait, token-set, and exact-token scopes. |

Admin read endpoints:

| Method | Path | Capability |
| --- | --- | --- |
| `GET` | `/api/:chain_ref/:collection_ref/bidding/jobs` | List declared bidding jobs and included token cards. |
| `GET` | `/api/:chain_ref/:collection_ref/:token_ref/bidding/job` | Get the exact-token bidding job, if one exists. |
| `POST` | `/api/:chain_ref/:collection_ref/bidding/jobs/target-lookup` | Resolve a token, trait, or collection draft target into an existing declared job. |
| `GET` | `/api/:chain_ref/:collection_ref/bidding/price-tiers` | List tiers plus collection bidding settings. |
| `GET` | `/api/:chain_ref/:collection_ref/bidding/price-tiers/:tier_id/reapply-preview` | Preview changed tier-backed jobs before applying a tier update. |

Admin mutation endpoints:

| Method | Path | Capability |
| --- | --- | --- |
| `PUT` | `/api/:chain_ref/:collection_ref/:token_ref/bidding/job` | Create, modify, activate, or pause an exact-token job. |
| `DELETE` | `/api/:chain_ref/:collection_ref/:token_ref/bidding/job` | Archive an exact-token job and enqueue active-offer cancellation. |
| `PUT` | `/api/:chain_ref/:collection_ref/bidding/jobs/traits` | Create, modify, activate, or pause a trait-scoped job. |
| `PUT` | `/api/:chain_ref/:collection_ref/bidding/jobs/tokens/batch` | Create or update token jobs from explicit token ids, filtered tokens, or token-offer selection. |
| `PUT` | `/api/:chain_ref/:collection_ref/bidding/jobs/collection` | Create, modify, activate, or pause the collection-wide job. |
| `DELETE` | `/api/:chain_ref/:collection_ref/bidding/jobs/:job_id` | Archive a token, trait, or collection job by job id. |
| `PUT` | `/api/:chain_ref/:collection_ref/bidding/price-tiers` | Create, modify, activate, or pause a price tier. |
| `DELETE` | `/api/:chain_ref/:collection_ref/bidding/price-tiers/:tier_id` | Archive a price tier. |
| `PUT` | `/api/:chain_ref/:collection_ref/bidding/settings` | Update collection-scoped bidding settings. |
| `POST` | `/api/:chain_ref/:collection_ref/bidding/price-tiers/:tier_id/reapply` | Apply selected staged tier changes to jobs and publish runtime wake-ups. |

All admin mutation endpoints are protected by local admin CSRF/host/origin checks through the backend's normal admin route path.

## Backend Test Coverage Snapshot

Snapshot date: `2026-05-15`.
Measured commit: `e8773eca29257b2d48b452b80d72bf825a76ed87`.

Coverage command:

```bash
ARTGOD_DB_PATH=/tmp/artgod-bidding-coverage-worktree.sqlite yarn workspace @artgod/backend test --coverage --coverage.reportsDirectory=/tmp/artgod-backend-coverage-bidding-worktree
```

Overall backend result:

| Scope | Files | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: | ---: |
| All backend coverage report files | 120 | 82.13% | 65.87% | 90.45% | 82.53% |
| `backend/src/application/use-cases/trading/` | 24 | 93.53% | 81.21% | 97.46% | 93.43% |
| `backend/src/http/handlers/trading/` | 19 | 91.84% | 85.82% | 100.00% | 91.75% |
| `backend/src/infra/trading/` | 4 | 85.57% | 70.58% | 93.89% | 85.68% |

Backend file coverage report:

The table below is the full bidding backend report.
Remaining gaps are recorded inline in the same row as the measured file instead of in a separate weak-spots list.

| Layer | File | Statements | Branches | Functions | Lines | Covered behavior / remaining gap |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Use case | `backend/src/application/use-cases/trading/apply-bidding-price-tier-reapply.ts` | 96.15% | 83.33% | 100.00% | 95.83% | Applies selected changed tier-backed jobs, rejects empty/non-tier-backed selections, and publishes wake-ups; only unchanged-result return detail remains thin. |
| Use case | `backend/src/application/use-cases/trading/archive-bidding-job.ts` | 91.67% | 50.00% | 100.00% | 91.67% | Archive-by-job-id path is covered; missing branch is negative path detail. |
| Use case | `backend/src/application/use-cases/trading/archive-collection-bidding-price-tier.ts` | 100.00% | 100.00% | 100.00% | 100.00% | Price-tier archive, unknown tier, already-archived tier, and durable command behavior are covered. |
| Use case | `backend/src/application/use-cases/trading/archive-token-bidding-job.ts` | 100.00% | 100.00% | 100.00% | 100.00% | Exact-token archive and cancellation command path are covered. |
| Use case | `backend/src/application/use-cases/trading/bidding-bid-book.ts` | 100.00% | 100.00% | 100.00% | 100.00% | Bid-book scope/filter constants and helpers are exercised. |
| Use case | `backend/src/application/use-cases/trading/bidding-collection-settings.ts` | 86.36% | 85.71% | 100.00% | 86.36% | Bidding collection setting parse/default behavior is covered. |
| Use case | `backend/src/application/use-cases/trading/bidding-job-pricing.ts` | 100.00% | 100.00% | 100.00% | 100.00% | Manual missing floor/ceiling, missing tier, invalid tier graph, and valid tier-backed scalar output are covered. |
| Use case | `backend/src/application/use-cases/trading/bidding-job-target-lookup.ts` | 94.44% | 90.91% | 100.00% | 94.44% | Token, trait, and collection target lookup variants are covered; only small null/empty edge branches remain. |
| Use case | `backend/src/application/use-cases/trading/bidding-price-tier-ports.ts` | n/a | n/a | n/a | n/a | Port/type contract only; no runtime statements emitted into coverage. |
| Use case | `backend/src/application/use-cases/trading/bidding-price-tier-reapply.ts` | 100.00% | 50.00% | 100.00% | 100.00% | Shared staged reapply calculation, changed diff, pricing source output, and unknown-tier error are covered; unchanged comparison branch remains thin. |
| Use case | `backend/src/application/use-cases/trading/bidding-price-tiers.ts` | 86.31% | 70.58% | 100.00% | 86.17% | Tier graph resolution, invalid Ether, missing parents, invalid graph output, and cycle rejection are covered; a few numeric parser branches remain. |
| Use case | `backend/src/application/use-cases/trading/bidding-token-offer-cards.ts` | 93.06% | 83.58% | 92.00% | 93.06% | Token-offer card grouping, pagination, and muted-offer behavior are covered; only small optional-field branches remain. |
| Use case | `backend/src/application/use-cases/trading/get-token-bidding-bid-book.ts` | 100.00% | n/a | 100.00% | 100.00% | Token bid-book API path is covered through API tests. |
| Use case | `backend/src/application/use-cases/trading/get-token-bidding-job.ts` | 100.00% | 100.00% | 100.00% | 100.00% | Exact-token job lookup is covered. |
| Use case | `backend/src/application/use-cases/trading/list-collection-bidding-bid-book.ts` | 86.00% | 72.41% | 92.31% | 86.00% | Orders fallback, snapshot selection, scopes, maker, and traits are covered; more SQL/source edge cases remain. |
| Use case | `backend/src/application/use-cases/trading/list-collection-bidding-jobs.ts` | 100.00% | 100.00% | 100.00% | 100.00% | Job list API path is covered. |
| Use case | `backend/src/application/use-cases/trading/list-collection-bidding-price-tiers.ts` | 100.00% | n/a | 100.00% | 100.00% | Price-tier list and settings API path is covered. |
| Use case | `backend/src/application/use-cases/trading/ports.ts` | n/a | n/a | n/a | n/a | Port/type contract only; no runtime statements emitted into coverage. |
| Use case | `backend/src/application/use-cases/trading/preview-bidding-price-tier-reapply.ts` | 100.00% | 100.00% | 100.00% | 100.00% | Reapply preview and unknown-tier error are covered. |
| Use case | `backend/src/application/use-cases/trading/trading-job-command-signal-port.ts` | n/a | n/a | n/a | n/a | Port/type contract only; no runtime statements emitted into coverage. |
| Use case | `backend/src/application/use-cases/trading/types.ts` | 100.00% | 88.89% | 100.00% | 100.00% | Shared validation, price parsing, range checks, and job view mapping are covered. |
| Use case | `backend/src/application/use-cases/trading/update-collection-bidding-settings.ts` | 100.00% | n/a | 100.00% | 100.00% | Bidding settings update API path is covered. |
| Use case | `backend/src/application/use-cases/trading/upsert-batch-token-bidding-jobs.ts` | 92.06% | 77.27% | 100.00% | 91.67% | Filtered, explicit, and token-offer selections are covered at use-case level. |
| Use case | `backend/src/application/use-cases/trading/upsert-collection-bidding-job.ts` | 88.89% | 66.67% | 100.00% | 88.89% | Collection job create/update API path is covered; some invalid branches remain. |
| Use case | `backend/src/application/use-cases/trading/upsert-collection-bidding-price-tier.ts` | 90.90% | 80.00% | 87.50% | 90.62% | Tier create/update, blank name, invalid sort order, missing parent, invalid graph, and resolution refresh behavior are covered. |
| Use case | `backend/src/application/use-cases/trading/upsert-token-bidding-job.ts` | 100.00% | n/a | 100.00% | 100.00% | Exact-token create/update and tier-backed token job paths are covered. |
| Use case | `backend/src/application/use-cases/trading/upsert-trait-bidding-job.ts` | 100.00% | 100.00% | 100.00% | 100.00% | Trait job create/update, quantity validation, trait target validation, canonicalization, duplicate rejection, and durable command publish are covered. |
| HTTP handler | `backend/src/http/handlers/trading/apply-bidding-price-tier-reapply.ts` | 88.89% | 83.33% | 100.00% | 88.89% | Reapply route mapping and invalid request branches are covered. |
| HTTP handler | `backend/src/http/handlers/trading/archive-bidding-job.ts` | 100.00% | n/a | 100.00% | 100.00% | Archive-by-job-id route is covered. |
| HTTP handler | `backend/src/http/handlers/trading/archive-collection-bidding-price-tier.ts` | 100.00% | n/a | 100.00% | 100.00% | Price-tier archive route is covered. |
| HTTP handler | `backend/src/http/handlers/trading/archive-token-bidding-job.ts` | 100.00% | n/a | 100.00% | 100.00% | Exact-token archive route is covered. |
| HTTP handler | `backend/src/http/handlers/trading/bidding-price-tier-http.ts` | 83.33% | 79.17% | 100.00% | 83.33% | Tier DTO parsing, valid input, and multiple validation branches are covered; a few optional config branches remain. |
| HTTP handler | `backend/src/http/handlers/trading/get-token-bidding-bid-book.ts` | 100.00% | n/a | 100.00% | 100.00% | Token bid-book route is covered. |
| HTTP handler | `backend/src/http/handlers/trading/get-token-bidding-job.ts` | 100.00% | n/a | 100.00% | 100.00% | Exact-token job lookup route is covered. |
| HTTP handler | `backend/src/http/handlers/trading/list-collection-bidding-bid-book.ts` | 100.00% | n/a | 100.00% | 100.00% | Collection bid-book route is covered. |
| HTTP handler | `backend/src/http/handlers/trading/list-collection-bidding-jobs.ts` | 100.00% | n/a | 100.00% | 100.00% | Job-list route is covered. |
| HTTP handler | `backend/src/http/handlers/trading/list-collection-bidding-price-tiers.ts` | 100.00% | n/a | 100.00% | 100.00% | Price-tier list route is covered. |
| HTTP handler | `backend/src/http/handlers/trading/lookup-bidding-job-target.ts` | 83.33% | 81.81% | 100.00% | 83.33% | Target lookup DTO mapping covers core variants, invalid quantity, empty trait target, and non-object trait entries. |
| HTTP handler | `backend/src/http/handlers/trading/preview-bidding-price-tier-reapply.ts` | 100.00% | n/a | 100.00% | 100.00% | Reapply preview route is covered. |
| HTTP handler | `backend/src/http/handlers/trading/trading-job-http.ts` | 93.75% | 95.00% | 100.00% | 93.75% | Shared job transport mapping and status validation are exercised by mutation routes. |
| HTTP handler | `backend/src/http/handlers/trading/update-collection-bidding-settings.ts` | 100.00% | 50.00% | 100.00% | 100.00% | Settings update route is covered; branch coverage needs invalid settings cases. |
| HTTP handler | `backend/src/http/handlers/trading/upsert-batch-token-bidding-jobs.ts` | 89.80% | 88.37% | 100.00% | 89.36% | Batch route token-id, filter, token-offer, maker, and malformed selection parsing are covered. |
| HTTP handler | `backend/src/http/handlers/trading/upsert-collection-bidding-job.ts` | 100.00% | n/a | 100.00% | 100.00% | Collection job route is covered. |
| HTTP handler | `backend/src/http/handlers/trading/upsert-collection-bidding-price-tier.ts` | 100.00% | 50.00% | 100.00% | 100.00% | Tier upsert route is covered; branch coverage needs invalid input cases. |
| HTTP handler | `backend/src/http/handlers/trading/upsert-token-bidding-job.ts` | 100.00% | n/a | 100.00% | 100.00% | Exact-token upsert route is covered. |
| HTTP handler | `backend/src/http/handlers/trading/upsert-trait-bidding-job.ts` | 100.00% | 100.00% | 100.00% | 100.00% | Trait job route mapping covers valid payloads, invalid quantity, empty trait targets, and non-object trait entries. |
| Infra | `backend/src/infra/collections/sqlite-collection-settings-repository.ts` | 90.00% | 75.00% | 100.00% | 90.00% | Generic collection settings persistence is covered. |
| Infra | `backend/src/infra/trading/nats-trading-job-command-signals.ts` | 93.75% | 66.67% | 84.62% | 100.00% | Disabled publisher, stream creation, publish payload, close, and failed background publish recovery are covered. |
| Infra | `backend/src/infra/trading/sqlite-bidding-bid-book-repository.ts` | 82.62% | 72.48% | 90.47% | 82.25% | Fresh/stale snapshot source selection, orders fallback retry, projected rows, token-set matching, malformed token-set exclusions, and SQL edge paths are covered; only narrow parser/logging branches remain. |
| Infra | `backend/src/infra/trading/sqlite-bidding-jobs-repository.ts` | 86.70% | 66.14% | 100.00% | 86.57% | Job persistence, commands, runtime joins, batch, and archive behavior are covered. |
| Infra | `backend/src/infra/trading/sqlite-bidding-price-tiers-repository.ts` | 91.43% | 83.33% | 100.00% | 91.18% | Tier persistence, reload, parent-child graph persistence, resolved scalar values, archive paths, and edge branches are covered. |

Documentation coverage note:

- `docs/backend-api.openapi.yaml` documents bid-book reads, job listing, exact-token job CRUD, trait jobs, batch token jobs, collection jobs, target lookup, price tiers, bidding settings, and tier reapply.
