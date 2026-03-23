# UI Interaction Guidelines

Scope: `frontend/src/app.css` and userland Svelte UI components under `frontend/src/lib/components`.

## Collection Page Shell

`CollectionPageLayout.svelte` is the canonical outer shell for collection-centered userland pages.

Shared structure:

1. breadcrumbs
2. primary section tabs
3. stacked top-action rows
4. page body

Primary section tabs are rendered by `CollectionSectionTabs.svelte` and currently expose:

- `tokens`
- `activities`
- `holders`

The active primary tab must be rendered as non-clickable text, not as a live link.

## Page Composition Rules

Collection pages should compose the shared shell like this:

1. `CollectionDetailView.svelte`
    - row 1: token status filter (`only listed` / `show all`)
    - row 2: trait panel controls
    - body: `TokenBrowserView.svelte`

2. `CollectionActivitiesView.svelte`
    - row 1: activity kind filter (`sales` / `listings` / `transfers`)
    - row 2: trait panel controls
    - body: activities table

3. `CollectionHoldersView.svelte`
    - row 1: holders summary
    - body: holders leaderboard

4. `HolderTokensView.svelte`
    - row 1: owner context text
    - row 2: trait panel controls
    - body: `TokenBrowserView.svelte`

Do not reintroduce page-level action rows inside leaf views once the action belongs to the shared page shell.

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
- Visual contract:
    - active/selected: orange
    - hover/focus: yellow
    - active tab is not clickable

### Secondary filter tabs

- Component/class family: `.secondary-tabs`
- Scope:
    - token status
    - token display mode
    - token media mode
    - activity kind filters
- Visual contract:
    - active/selected: orange
    - hover/focus: yellow
    - active item is not clickable

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
    - `TraitFacetPanel.svelte`
    - `trait-facet-panel-controller.ts`
- Base action class: `.facet-panel-action-button`

Specific controls:

- `traits`
    - structural toggle for the sidebar
    - lives in its own top-action row
- `reset`
    - clears current trait filters in the current page scope
    - default color is pink
    - hover/focus is yellow, aligned with other interactive controls

## Trait Panel Behavior

Trait panel behavior is centralized in `trait-facet-panel-controller.ts`.

The controller owns:

- collapsed state
- persisted collapsed preference
- root-class syncing
- `T` hotkey for panel toggle
- `R` hotkey for trait reset

The split of responsibilities is:

- `TraitFacetPanel.svelte`
    - presentational sidebar
    - local trait-value search
    - checkbox UI
- `TraitFacetPanelControls.svelte`
    - presentational top-action controls
- page wrappers
    - URL construction
    - reset navigation behavior

Trait value selection rules:

- plain click toggles trait values additively within the same trait key
- `Ctrl` + click isolates the clicked value within that trait key and clears the others in that group

## Trait Filter State

Trait selection is URL-driven, not hidden client-only state.

Trait-aware pages:

- collection tokens
- collection activities
- holder-token page

The collection holders leaderboard is intentionally not trait-aware and acts as the reset boundary.

Navigation rules:

- collection `tokens` <-> collection `activities` preserve trait filters
- holder-token page -> collection `tokens` / `activities` preserves trait filters
- collection `tokens` / `activities` -> holder-token page does not carry trait filters
- collection `holders` leaderboard does not preserve trait filters

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
