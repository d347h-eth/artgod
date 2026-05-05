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

## Default Width Policy

Do not stretch forms, tables, or configuration panels to full available page width by default.

Default layout expectation:

- compact
- fit-to-content
- centered horizontally within the available page area

Use full-width stretching only when the user explicitly asks for it or when the content genuinely requires it.

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

### Collection Query-Control Preferences and Shortcuts

- `1` opens `asks`.
- `2` opens `offers`.
- `3` opens `tokens`.
- `4` opens `bidding`.
- `S` cycles the `bid_scope` query control using the ordered values defined in `bidding-query.ts` (`token`, `traits`, `collection`).
- Collection and bidding shortcuts must not fire while a text-entry target is focused.
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
- template syntax is placeholder substitution mixed with literal text, for example `L{Level}/B{Biome}/{Zone}`
- missing placeholders render as empty strings

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
