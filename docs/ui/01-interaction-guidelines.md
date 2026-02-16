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
