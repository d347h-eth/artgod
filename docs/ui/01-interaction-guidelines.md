# UI Interaction Guidelines

Scope: `frontend/src/app.css` and Svelte UI components.

## Control Categories

1. Transient actions (one-shot requests/navigation):
    - Use `.button-link` for link-like actions (`load next`, `load previous`, etc.).
    - Use `.facet-reset-button` for button actions with the same intent (`reset`).
    - Visual contract: orange default, yellow hover/focus.

2. Persistent view toggles (state mode switches):
    - Use `.mode-toggle-button` (for `grid`/`table` mode).
    - Visual contract: cyan default, pink hover/focus.
    - Toggle text should show the target mode (the opposite of current mode).

3. Structural layout toggles (panel collapse/expand):
    - Use `.facet-collapse-button`.
    - Keep compact shape and explicit directional glyph (`<` / `>`).

## Interaction States

- All interactive controls must have:
    - `cursor: pointer`
    - hover style
    - keyboard-visible focus style (`:focus-visible`)
- Busy states should be explicit where applicable:
    - Example: `.button-link[aria-busy='true']` uses reduced opacity + no pointer events.

## Consistency Rules

- Avoid introducing one-off button palettes for the same interaction type.
- Reuse existing interaction classes before adding new ones.
- Keep action semantics aligned:
    - transient action => transient action style
    - persistent mode toggle => persistent toggle style
    - structural collapse => structural toggle style

## Pagination Patterns

New page implementations should choose one of these two pagination types and not invent a third pattern.

1. **Bidirectional window pagination**
    - Use when the user needs to move both forward and backward through the result set.
    - Canonical example: collection detail token browser.
    - Contract:
        - backend page includes `prevCursor` and `nextCursor`
        - frontend keeps an accumulated visible window in browser state
        - UI may expose both `load previous` and `load next`
    - Use for browsing surfaces where revisiting earlier rows without resetting the page is part of the expected flow.

2. **Forward-only append pagination**
    - Use when the user starts at the top and only keeps moving downward.
    - Canonical example: collection holders page.
    - Contract:
        - backend page includes `nextCursor` only
        - frontend keeps an append-only accumulated visible window in browser state
        - UI may expose `load next` or auto-load on scroll reach
        - no `prevCursor`, no backward traversal contract
    - Use for ranked lists, feeds, and other top-to-bottom reading flows.

Selection rule:

- If the page needs real backward traversal, use bidirectional window pagination.
- If the page is naturally append-only from the top, use forward-only append pagination.
- Keep pagination cursor-based and URL-driven in both cases.
