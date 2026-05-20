# Sync Backfill Isometric View Plan

Status: in progress.

## Goal

Replace the current flat sync/backfill block grid with an isometric stacked-level view while preserving the existing page behavior.

The first pass renders the current navigable path only:

- root page by itself when no bucket path is selected
- root plus selected child pages when the URL stack points deeper
- no fully expanded chain tree rendering

This keeps the rendered tile count bounded and matches the existing drill-down model.

## Settled Decisions

- The isometric view replaces the current square grid; no grid toggle is planned for the first pass.
- Each visible level is rendered as a separate isometric grid, stacked vertically with clear spacing.
- Root and other incomplete levels may use the smallest square that fits the current cell count, with padded empty slots.
- Full 1024-cell levels remain visually `32x32`.
- Bucket/range math remains unchanged; reshaping is presentation-only.
- Selection mode is constrained to one visible level. The second click must target the same level as the first click.
- Existing summary chips, selected-range widget, collection filter, backfill controls, and scheduling flow remain in the parent page.
- The isometric library should be imported as a real pinned package dependency.

## Implementation Boundary

Keep the control layer tight:

- reuse existing sync/backfill API responses for each visible path level
- reuse the existing range-summary endpoint for Ctrl-click and selected ranges
- reuse the current stack URL contract for navigation
- isolate isometric rendering in a dedicated frontend component
- keep presentation mapping in pure helpers where possible

Avoid for the first pass:

- a fully expanded Ethereum hierarchy
- new labels or data overlays inside isometric tiles
- backend range-derivation changes
- a new backend endpoint unless the frontend multi-fetch path proves awkward

## Planned Slices

### Slice 1: Dependency And Data Shape

- Add the pinned isometric package dependency.
- Extend the page load path so the frontend can fetch the root plus each selected stack page.
- Introduce a small frontend type for visible sync/backfill levels.
- Preserve the existing single-page state as the active/current level for summaries and controls.

### Slice 2: Isometric Renderer

- Add an isometric grid component that mounts client-side only.
- Render each visible level as top-plane tile rectangles.
- Compute square presentation dimensions from cell count.
- Pad incomplete presentation grids with disabled empty slots.
- Map existing tile state to the same semantic colors used by the current grid.

### Slice 3: Interaction Parity

- Route normal clicks through the existing drill-down behavior.
- Preserve Ctrl-click range-summary behavior.
- Preserve leaf block click summary behavior.
- Preserve deployment block marker coloring.
- Preserve selection mode with same-level two-click selection.
- Preserve selected-range highlighting.

### Slice 4: Verification And Review Split

- Run focused frontend tests/checks.
- Run TypeScript build.
- Run `git diff --check`.
- Commit in isolated unsigned chunks:
  1. progress plan
  2. dependency/data shape
  3. renderer and styling
  4. interaction parity and tests

## Open Checks

- Confirm the package export shape after adding the pinned dependency.
- Confirm the SVG event accessibility path for keyboard users.
- Confirm rendered size and spacing at desktop and mobile widths.
- Confirm selection-mode same-level enforcement remains obvious without extra helper text.
