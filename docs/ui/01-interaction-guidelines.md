# UI Interaction Guidelines

Scope: `frontend/src/app.css` and userland Svelte UI components under `frontend/src/lib/components`.

For first-principles preview overlay behavior, see `docs/ui/02-preview-modal-system.md`.

## Collection Page Shell

`CollectionPageLayout.svelte` is the canonical outer shell for collection-centered userland pages.

Shared structure:

1. breadcrumbs
2. primary section tabs
3. stacked top-action rows
4. page body

Primary collection navigation is rendered by `CollectionSectionTabs.svelte` and currently exposes:

- grouped `explore`: `asks`, `offers`, `tokens`
- standalone `bidding`
- grouped `events`: `sales`, `listings`, `transfers`
- `holders`
- `customization`

Collection cross-page navigation URLs are built by `frontend/src/lib/collection-navigation.ts`.
Collection views should pass an explicit typed navigation state into `buildCollectionNavigation(...)` and then pass the resulting `CollectionNavigation` to `CollectionPageLayout.svelte`; do not rebuild tokens / activities / bidding / holders / customization hrefs ad hoc in each view.

The active primary tab must be rendered as non-clickable text, not as a live link, and must not use pointer/hover behavior.

Top-action rows are page chrome and should stay compact.

Rules:

- top-action rows stack vertically under the primary section tabs
- every top-action row should use the same vertical gap
- controls inside one row should use the same compact horizontal gap
- left-side controls stay aligned to the left edge of the page content
- do not push buttons, tabs, or action groups to the far-right edge by spanning the whole page width
- keep controls in compact left-aligned groups unless a specific layout is explicitly approved
- bidding/filter controls belong in top-action rows, not inside token-card grids or result summaries

## Shared Page Skeleton

The userland page skeleton is shared product chrome and must stay stable across pages.

Shared skeleton includes:

- page title/header rows
- primary navigation tabs
- chain/context selectors and top control rows
- shared page-shell spacing and alignment

Rules:

- do not center, stretch, or otherwise reposition shared skeleton elements to satisfy a feature-body layout request
- when a feature body needs centered content, scope the centering to a dedicated wrapper below the relevant top controls
- preserve the existing left-aligned compact chrome unless a request explicitly names the page shell/navigation itself
- feature-specific visualizations may use their own centered grids, but their CSS must not mutate generic `.panel`, `.panel-header`, navigation tab, or shared top-action behavior
- side panels attached to a centered visualization should align through one shared layout grid, not through per-row content width

## Default Width Policy

Do not stretch forms, tables, or configuration panels to full available page width by default.

Default layout expectation:

- compact
- fit-to-content
- centered horizontally within the available page area

Use full-width stretching only when the user explicitly asks for it or when the content genuinely requires it.

Within compact forms and panels, visual alignment matters as much as outer width.

Rules:

- use grid-like row layouts for label/value and label/input pairs
- keep labels, inputs, and buttons on stable columns
- make repeated controls the same width when they represent the same kind of action or value
- prefer balanced label/control proportions over label-heavy or input-heavy layouts
- do not let one long label or select option push the whole form wider than its intended panel
- clip or constrain long user-provided names in controls and expose the full value through hover text when needed

## Pattern Reuse

Do not invent a new visual/control pattern when an established one already exists in the userland UI.

Default expectation:

- reuse the existing component/class family for the same kind of interaction
- preserve its current interaction contract
- active/selected items stay non-clickable when that is already the established pattern

If a new control pattern is genuinely needed, get explicit approval first instead of silently introducing a near-duplicate style or behavior.

## Page Composition Rules

Collection pages should compose the shared shell like this:

1. `CollectionDetailView.svelte`
    - row 1: trait panel controls
    - body: `TokenBrowserView.svelte`

2. `CollectionActivitiesView.svelte`
    - row 1: trait panel controls
    - body: activities table

3. `CollectionHoldersView.svelte`
    - row 1: holders summary
    - body: holders leaderboard

4. `HolderTokensView.svelte`
    - row 1: owner context text
    - row 2: trait panel controls
    - body: `TokenBrowserView.svelte`

5. `CollectionCustomizationView.svelte`
    - no stacked top-action rows by default
    - body: collection-scoped customization panels
    - implemented sections:
        - trait filter presentation
        - token card trait summary template
        - activity row trait summary template
    - each section uses a compact three-column grid:
        - setting label / trait key
        - user-defined setting
        - extension-defined setting

Do not reintroduce page-level action rows inside leaf views once the action belongs to the shared page shell.

Token status, collection activity kind, and bidding view navigation belong to `CollectionSectionTabs.svelte`.
Do not re-add duplicate secondary controls for those promoted main-navigation choices inside leaf views.

## Inner Content Toolbars

`TokenBrowserView.svelte` owns an inner `results-toolbar`.

That toolbar is local content chrome, not page chrome. It is the correct place for:

- results summary
- `load previous`
- display mode tabs (`grid` / `table`)
- media mode tabs (`artifact` / `snapshot` / future extension modes)

Do not name these inner toolbars `panel-top-actions`; reserve that name for page-level action rows owned by `CollectionPageLayout`.

## Control Categories

### Primary section tabs

- Component/class family: `CollectionSectionTabs.svelte`, `.runtime-tabs`
- Scope: top-level collection page navigation
- Includes grouped collection choices: `explore` (`asks`, `offers`, `tokens`) and `events` (`sales`, `listings`, `transfers`)
- Visual contract:
    - active/selected: orange
    - hover/focus: yellow
    - active tab is not clickable and uses default cursor

### Secondary filter tabs

- Component/class family: `.secondary-tabs`
- Scope:
    - token display mode
    - token media mode
    - bid scope filters
- Visual contract:
    - active/selected: orange
    - hover/focus: yellow
    - active item is not clickable
    - active item uses default cursor and must not expose hover/active link behavior
    - do not replace active text with clickable active buttons in one-off pages

### Transient action links/buttons

- Class family: `.button-link`
- Scope:
    - `load next`
    - `load previous`
    - `older`
    - `newer`
- Visual contract:
    - default: orange
    - hover/focus: yellow

### Help modal

- Components:
    - `KeyboardShortcutsHelp.svelte`
    - `keyboard-shortcuts-help-controller.ts`
- Scope:
    - collection page shell header
- Visual contract:
    - `?` trigger sits on the far right of the shared `panel-header`
    - trigger uses the same button treatment as other normal action buttons
    - modal is a centered floating overlay with a light backdrop
    - `F1` opens/closes the modal
    - `Esc`, backdrop click, and the `x` button close the modal

### Trait panel controls

- Components:
    - `TraitFacetPanelControls.svelte`
    - `SelectedTraitFilterSlugs.svelte`
    - `TraitFacetPanel.svelte`
    - `trait-facet-panel-controller.ts`
- Base action class: `.facet-panel-action-button`

Specific controls:

- `filter`
    - structural toggle for the sidebar
    - lives in its own top-action row
    - uses the active orange state while the trait panel is open
- trait join mode
    - optional compact fixed-width `OR` / `AND` button beside `filter`
    - changes the current page's trait-filter join mode without clearing selected filters
- `reset`
    - clears current trait filters in the current page scope
    - default color is pink
    - hover/focus is yellow, aligned with other interactive controls
- selected trait slugs
    - render inline after `filter` / `reset`
    - use compact `key=value` labels clipped to 20 characters
    - wrap naturally only when viewport width requires it
    - clicking one slug removes only that applied filter

### Bidding selection controls

- Component family: `BiddingSelectionControls.svelte` plus the shared token-selection controller state.
- Scope:
    - collection `asks`
    - collection `tokens`
    - collection bidding `bid_scope=token`
    - collection bidding `bid_scope=traits`
    - collection bidding `bid_scope=collection`
- Placement:
    - always render in a page-level top-action row
    - keep `tiers` in the same row as bid-target actions
    - keep these controls out of result summaries and token-card grids

Control rules:

- `tiers` toggles collection price-tier management.
- `bid on traits` drafts a trait-scoped bidding target from the current trait filter or selected trait bucket.
- `bid on all tokens` drafts token-scoped bidding targets for every token matching the current filters across the full result set.
- `bid on this page` narrows an all-pages token draft to the currently loaded page only and should only appear when it is meaningfully different.
- `place collection bid` drafts a collection-scoped bidding target from the current collection bid context.
- selected-count text is plain text, not a button.
- `clear` removes only the current bidding target and must not reset trait filters.
- asks, tokens, and offers must share this component instead of each implementing their own action row.
- public single-collection deployments may show read-only offers, but must not expose bidding job or tier write controls.

### Button and focus behavior

Action polarity and placement:

- negative, cancel, discard, or exit buttons go on the left side of the action group and use the orange control family
- positive, accept, confirm, commit, or submit buttons go on the right side of the action group and use the cyan control family
- when the row is compact instead of full-width, keep a significant visual gap between the negative-left and positive-right buttons
- do not render a positive/confirm button before the matching negative/cancel button
- use the shared `.action-button-negative` and `.action-button-positive` classes unless a component has an existing documented equivalent

Button-like controls should not retain pointer focus after mouse or touch activation.

Rules:

- keyboard focus must remain available for keyboard navigation
- pointer activation may release focus after the click action
- do not add one-off `blur()` calls inside individual buttons
- if this behavior is needed globally, use a shared pointer-focus helper
- active/selected navigation controls must be visually selected but inert, with no pointer cursor and no hover affordance
- stateful toggles such as `filter`, `tiers`, and `traits` remain clickable while active and should keep the normal hover/focus color behavior
- reset or clear-state controls must use `.facet-panel-action-button.facet-reset-button`; they are pink by default and must not use orange, which is reserved for selected or active toggle and enum states

## Trait Panel Behavior

Trait panel behavior is centralized in `trait-facet-panel-controller.ts`.

The controller owns:

- collapsed state
- persisted collapsed preference
- root-class syncing
- `F` hotkey for panel toggle
    - pages can override this for page-specific shortcut behavior
- `R` hotkey for trait reset

The split of responsibilities is:

- `TraitFacetPanel.svelte`
    - presentational sidebar
    - local trait-value search
    - checkbox UI for discrete traits
    - inclusive `from` / `to` range UI for scalar traits
- `TraitFacetPanelControls.svelte`
    - route-agnostic top-action controls
    - selected filter slug rendering via `SelectedTraitFilterSlugs.svelte`
    - selected filter removal as route-agnostic selected-filter state mutation
- page wrappers
    - URL construction
    - reset navigation behavior
    - applying changed selected-filter state to the current route

Bidding-specific trait behavior:

- collection bidding offers use `OR` trait join by default for trait discovery
- `OR` join means any selected `key=value` match can keep a trait bucket visible
- `AND` join means each selected `key=value` must be present in the trait bucket
- when filters are active, do not silently cycle the join mode unless the user explicitly clicks the join-mode control
- `bid_scope=collection` does not render the trait facet panel because collection-wide bids are not trait-filtered
- selecting a trait bucket for bidding should also apply its traits to the visible trait filters so the panel, bid controls, and URL stay coherent

### Collection Query-Control Preferences and Shortcuts

- `1` opens `asks`.
- `2` opens `offers`.
- `3` opens `tokens`.
- `4` opens `bidding`.
- `S` cycles the `bid_scope` query control using the ordered values defined in `bidding-query.ts` (`token`, `traits`, `collection`).
- `T` toggles collection price-tier management where bidding controls are available.
- `B` collapses or expands the bidding job panel where the panel is available.
- `C` clears the current bidding target where bidding controls are available.
- Collection and bidding shortcuts must not fire while a text-entry target is focused.
- Checkbox and radio focus must not trap page-level shortcuts after pointer activation.
- Last selected `bid_scope` is a global local UI navigation preference stored in `localStorage`.
- Bidding route load applies stored `bid_scope` before backend fetches during browser-side navigation when the URL omits `bid_scope`.
- Explicit `bid_scope` URL params always override stored bidding navigation preferences.
- New scoped query-control preferences should use `query-control-preferences.ts` instead of one-off `localStorage` helpers.

## Navigation State Ownership

Choose the smallest state ownership model that preserves correct navigation behavior.

URL-owned state:

- Use for filters, scopes, sorts, pagination, sub-pages, and any control that changes fetched data or the semantic content of the page.
- Benefits: correct SSR, refresh, browser history, copy/paste, and shareable links.
- Implementation: parse in route load, pass through page data, and preserve through `collection-navigation.ts` when cross-page links should carry it.

Browser preference state:

- Use for local defaults that improve return navigation inside an ongoing browser session but do not need shareable URLs.
- Benefits: avoids polluting unrelated URLs with page-specific controls.
- Limitation: not authoritative for hard reload / SSR because `localStorage` is unavailable on the server.
- Implementation: read in browser-side route load before data fetch when the preference changes backend query inputs; otherwise keep it in component/controller state.
- Frontend `localStorage` key literals must be defined in `frontend/src/lib/local-storage-keys.ts`, not scattered through feature files.

Cookie preference state:

- Use only when a hidden preference must affect SSR and the same URL rendering differently per user is acceptable.
- Prefer this for presentation defaults, not data-shaping controls.
- Avoid cookies for filters/scopes that should be visible, shareable, and easy to debug from the URL.

Component-only state:

- Use for transient interaction state that does not need navigation persistence, such as open menus or in-flight UI affordances.

Trait value selection rules:

- plain click toggles trait values additively within the same trait key
- `Ctrl` + click isolates the clicked value within that trait key and clears the others in that group

Trait presentation rules:

- default facet rendering is `set`
- collection customization can mark individual trait keys as `range`
- range traits render `from` / `to` inputs with inclusive bounds
- range traits show numeric `min` / `max` hints from the current page scope
- owner-token pages use owner-scoped range hints
- collection tokens and collection activities use collection-scoped range hints
- non-numeric stored trait values are ignored for range bounds and range filtering

Trait summary template rules:

- token card compact summary is backend-rendered from the effective token-card template
- activity-row trait summary is backend-rendered from the effective activity-row template
- empty template means “render no summary”
- token browser no longer falls back to dumping all trait values on split lines when the template is empty
- activities page shows the `traits` column only when the activity-row template feature is enabled for the current collection
- template syntax is placeholder substitution mixed with literal text, for example `{Zone}/B{Biome}/{Chroma}/L{Level}`
- missing placeholders render as empty strings
- templates may include line breaks; token cards and activity rows preserve those line breaks
- templates support constrained conditional sections:
    - `{{#if Trait}}text{{/if}}` renders `text` when `Trait` has a non-empty value
    - `{{#if Trait=Value}}text{{/if}}` renders `text` when `Trait` exactly matches `Value`
- trait summary templates must not evaluate JavaScript or arbitrary expressions

## Trait Filter State

Trait selection is URL-driven, not hidden client-only state.

Both discrete and range filters are URL-driven.

Trait-aware pages:

- collection tokens
- collection activities
- collection bidding `bid_scope=token`
- collection bidding `bid_scope=traits`
- holder-token page

The collection holders leaderboard is intentionally not trait-aware and acts as the reset boundary.

Navigation rules:

- primary collection navigation built through `collection-navigation.ts` preserves trait filters for trait-aware destinations
- collection `tokens` <-> collection `activities` <-> collection bidding preserve trait filters
- holder-token page -> collection `tokens` / `activities` / bidding preserves trait filters
- collection `tokens` / `activities` -> holder-token page does not carry trait filters
- collection `holders` leaderboard does not preserve trait filters

Trait filter query families:

- discrete values: repeated `traits=key:value`
- scalar ranges: repeated `trait_ranges=key:from..to`

## Bidding Bid Book Presentation

Bid-book surfaces should be reusable across collection bidding pages and token detail pages.

General rules:

- bid-book metadata renders as one compact horizontal chip row
- metadata labels use `key: value` formatting
- the source label is `refresh pace`
- user-facing refresh pace values are `normal` and `competitive`
- timing/projection diagnostics belong in logs, not in the bid-book metadata row
- bid rows should not use table row borders for visual grouping
- use spacing, buckets, and muted state instead of heavy separators
- prices align consistently and should not gain extra decimal precision from hidden or collapsed rows
- display `WETH` only where currency disambiguation is useful
- own bids should be visually marked and labeled as the user when the wallet identity is known
- own-bid badges are limited to `queued`, `paused`, `verifying`, `replacing`, `canceling`, `cancel failed`, `cancelled`, `winning`, `draw`, `losing`, `hit ceiling`, and `at floor`
- `winning`, `draw`, and `losing` must come from fresh bot runtime decision feedback, never from frontend/backend price inference
- stale active orders must remain visible with lifecycle badges until backend cancellation evidence confirms they can disappear

Scope rules:

- collection-wide scope may render as compact `C`
- hide the scope column when the current view can only contain one obvious scope
- token detail bid books should keep the scope column because the token can receive collection, trait, token, and token-set offers
- trait scope views group individual bids under canonical trait-combination buckets; do not replace the individual bid list with aggregate-only rows
- trait bucket titles should display selected tab trait keys first, then remaining keys in stable order
- clickable trait values in bucket titles should apply the same trait filter controls as the facet panel

Muted and collapsed rows:

- muted bids remain useful for debugging but should be hidden by default
- `show_muted=true` in the URL may reveal muted rows for diagnostics
- collection and token bid lists mute bids below 10% of the top displayed bid
- trait bid tabs also mute bids and buckets below 50% of the tab median bid
- muted bids should not contribute to user-facing bucket summary stats
- the bottom price percentile may be collapsed by default when the list is large, but expansion should not alter the primary top-row decimal formatting

Time display:

- `placed` and `valid` default to relative time
- the time value itself toggles between relative and absolute display
- do not add separate `REL` / `ABS` links beside time values
- use RFC 3339 without sub-second precision for absolute timestamps

## Token Card Bidding Selection

Token cards can participate in bidding selection without changing their normal navigation behavior.

Rules:

- `Ctrl` + left click on token-card non-link areas toggles token selection
- middle click on token-card non-link areas toggles token selection
- token ID links and marketplace price links must keep browser-native `Ctrl` / middle-click open-in-new-tab behavior
- media preview clicks keep their existing behavior unless the selection gesture is active
- selected cards show a clear selected background/effect without relying on a loud orange border
- selected cards may expose a small deselect affordance so users do not need the modifier key to remove one card
- token selection state must be one shared source of truth for selection count, card visuals, and bidding draft data
- broad filtered-token selection should mean all matching tokens across the full filtered result set, not only currently rendered cards

Token-card market labels:

- asks, tokens, offers, and future token-card market surfaces should reuse the same ask/bid price label component
- ask and bid icons should use the shared market icon treatment and palette
- ask and bid price groups should have enough spacing to read as separate market sides
- adding bid labels later must not require a separate token-card layout fork

## Bidding Job Panel

The bidding job panel is a reusable form surface for floating browser-page bidding flows and inline token-detail bidding.

General rules:

- use one shared component for floating and inline rendering
- token detail inline rendering must not show the floating-only `hide` control
- floating panel `hide` collapses the panel without clearing current draft state
- panel controls should sit flush in the bottom-right corner when floating
- forms should use a balanced label/control grid with consistent inner padding
- labels should be visually quieter than values and inputs
- labels and inputs should align to one clean grid, not drift into independent columns
- form rows should use one consistent label column width and one consistent control column width
- labels should align to the control edge in dense forms so the label/input relationship is clear
- inputs that represent the same kind of scalar value should share the same width
- action buttons in the same form should share the same width unless their role genuinely requires otherwise
- left and right button groups should align to the same row grid and keep a stable gap between groups
- single right-side actions should align to the bottom of the left action stack instead of floating at the top
- feedback/status text should align to the form grid or center of the panel, not drift toward one edge
- avoid status dropdowns; expose user intent through action buttons instead
- the panel state row must reuse the same own-bid badge contract as the bid book
- queued jobs stay `queued` until a fresh bot-snapshot market row or runtime-backed own row has a bot-persisted `winning`, `draw`, or `losing` decision
- raw runtime fields such as current price and active order id are diagnostics, not primary panel state

Action rules:

- new job state uses `create` as the positive action
- existing active job state uses `modify`, `pause`, and `archive`
- paused job state uses `modify`, `activate`, and `archive`
- ineligible actions stay visible only when useful, but disabled and muted
- positive job actions use the cyan control family
- negative job actions use the orange control family
- job state-changing actions require double-click confirmation
- the armed confirmation state clears on outside click, focus change, or another interaction

Pricing rules:

- manual pricing and tier pricing use explicit selection controls
- tier button labels are fixed width and clipped to protect panel layout
- long tier names may be exposed through a hover title, still clipped to a safe length
- selecting a tier fills floor, ceiling, and delta from that tier
- tier-selected prices are visible but not directly editable
- switching back to manual keeps the last resolved values for reuse
- collection settings may switch tier selection from inline buttons to a dropdown when a collection has many tiers

## Media Mode State

Collection media selection is URL-driven and extension-aware.

Rules:

- backend still returns a single effective media set per token response
- collection pages receive `media.selectedMode`, `media.defaultMode`, and `media.availableModes`
- token browser and holder-token browser expose the page-level media switch in the inner `results-toolbar`
- token preview modal inherits the current page media mode on open and can cycle modes locally for that token only
- in token-browser surfaces, token preview modal can step through the current visible token results
- token detail page honors `media_mode` from the URL on load, then exposes a local floating media switch for page-only inspection
- `V` cycles to the next media mode in the ordered list
- when token preview modal is open, `V` affects the modal only
- when token preview modal is open in token-browser surfaces, `A` / `ArrowLeft` opens the previous token and `D` / `ArrowRight` opens the next token
- on token detail page, `V` affects only the currently opened token detail media
- otherwise `V` affects the page-level media mode in token-browser surfaces
- collection page navigation preserves `media_mode` across:
    - tokens
    - activities
    - holders
    - holder-token pages
    - token detail
- pages that do not render token media may still carry `media_mode` forward as navigation state

## Pagination Patterns

Choose one of these patterns and do not invent a fourth.

### 1. Bidirectional accumulated window pagination

Use when the user needs backward and forward traversal while keeping an accumulated visible window in browser state.

Canonical examples:

- collection token browser
- holder-token browser

Contract:

- backend page includes `prevCursor` and `nextCursor`
- frontend keeps an accumulated visible window in browser state
- UI may expose both `load previous` and `load next`

### 2. Bidirectional page navigation

Use when the user moves newer/older across discrete cursor pages and the UI does not keep an accumulated local window.

Canonical example:

- collection activities page

Contract:

- backend page includes `prevCursor` and `nextCursor`
- frontend navigates page-to-page via URL
- UI may expose `newer` / `older`

### 3. Forward-only append pagination

Use when the user starts at the top and only keeps moving downward through a ranked list.

Canonical example:

- collection holders leaderboard

Contract:

- backend page includes `nextCursor` only
- frontend keeps an append-only accumulated visible window in browser state
- UI may expose `load next` and/or auto-load on scroll reach

Selection rule:

- If revisiting earlier rows inside the same visible window matters, use bidirectional accumulated window pagination.
- If the user just moves across newer/older pages, use bidirectional page navigation.
- If the surface is naturally top-to-bottom and append-only, use forward-only append pagination.
- Keep pagination cursor-based and URL-driven in every case.
