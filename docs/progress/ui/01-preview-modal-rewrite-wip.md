# Preview Modal Rewrite WIP

Status: staging note for a full preview-modal revamp.

Canonical target design:

- `docs/ui/02-preview-modal-system.md`

This document captures the current implementation gaps against the canonical preview-modal system and defines the intended rewrite boundary. It is not the implementation plan itself.

## Why This Exists

The current preview modal is not just cosmetically off from the canonical design. It is based on a different model:

- mixed `iframe` / raw `img` rendering
- height-first sizing
- static `vh` / `vw` assumptions
- inline page mounting

The canonical design instead requires:

- always-sandboxed `iframe` rendering
- viewport-derived contain-fit sizing
- a single persisted scale factor
- explicit centering and viewport ownership
- responsive behavior across resize and orientation changes

This mismatch is large enough that a clean rewrite is preferred over incremental patching.

## Current Implementation Snapshot

Primary files:

- `frontend/src/lib/components/TokenPreviewOverlay.svelte`
- `frontend/src/lib/components/token-preview-controller.ts`
- `frontend/src/app.css`

Current behavior, in short:

- preview opens inline inside page components
- preview media is fetched on demand
- media renders as `iframe` when `animationUrl` exists
- media renders as raw `img` when only `image` exists
- persisted user sizing controls only preview height percent
- CSS uses `90vh` / `90vw`-style bounds and a hard-coded iframe aspect ratio

## Audit Findings

### 1. Security model divergence

The current overlay renders raw `img` for image-only tokens.

Why this matters:

- the canonical design requires preview media to always render inside a sandboxed iframe
- this is a core security invariant, not a visual preference

Implication:

- the current implementation already violates the top-down isolation rule

### 2. Wrong sizing model

The current controller persists only a height percent and exports that as a CSS variable.

Why this matters:

- the canonical design defines one scalar preview scale factor
- that scalar must be applied to the current usable viewport box
- sizing must be derived from available viewport width and height together

Implication:

- current behavior is height-driven, not viewport-box-driven
- width fitting becomes incidental instead of guaranteed

### 3. Hard-coded media assumptions

The current iframe styling uses a fixed `3 / 4` aspect ratio.

Why this matters:

- the canonical system must support arbitrary media aspect ratios
- contain-fit behavior must come from viewport-box math, not a fixed ratio guess

Implication:

- the current implementation bakes in assumptions that conflict with the design target

### 4. No real viewport model

The current implementation relies on plain `vh` / `vw` CSS sizing and does not model:

- visual viewport changes
- safe-area insets
- orientation changes
- dynamic recomputation on resize

Why this matters:

- the canonical design is explicitly viewport-driven and continuous
- mobile viewport behavior is one of the main reasons the current modal became unreliable

### 5. Modal ownership is too weak

The current preview overlay is mounted inline inside page components.

Why this matters:

- the canonical design wants modal ownership at top level, equivalent to a body-level portal
- preview layout should not depend on incidental ancestor layout, overflow, or width behavior

Implication:

- current mounting makes the modal more fragile than the target system allows

### 6. Missing stable loading/error composition

The current modal opens before media resolves, but does not render an explicit loading box or stable media box placeholder.

Why this matters:

- the canonical design expects the preview to remain centered and visually stable in loading, loaded, and error states

Implication:

- current behavior can feel visually inconsistent during async state transitions

### 7. Missing background scroll lock

The canonical design explicitly expects background page scrolling to be locked while the modal is open.

This is currently not modeled as part of the preview system.

## Rewrite Boundary

The following pieces should be treated as replaceable:

- `frontend/src/lib/components/TokenPreviewOverlay.svelte`
- `frontend/src/lib/components/token-preview-controller.ts`
- the preview-modal CSS block in `frontend/src/app.css`

These pieces can be preserved conceptually, but should be reattached to the new system rather than treated as constraints on the rewrite:

- preview invocation from token browser and activities
- close behavior
- preview media-mode cycling
- adjacent-token navigation behavior
- persisted user preview scale as a concept

## Target Rewrite Shape

The replacement system should center around one consistent modal model:

- one modal host with top-level ownership
- one preview state model for open/loading/ready/error
- one persisted scalar scale preference in the range `5..100`
- one viewport-derived preview-box computation path
- one always-sandboxed iframe rendering path

The rewrite should be driven by `docs/ui/02-preview-modal-system.md`, not by compatibility with the old implementation.

## Constraints Already Settled

The following design constraints are already decided:

- preview media must always be sandboxed and rendered through `iframe`
- responsive-document mode is the first-class operating mode
- fixed-layout scaled mode is only future work
- fixed-layout support must not rely on runtime DOM inspection or mutation inside the iframe

## Open Work

Still needed later:

- a concrete embedded implementation plan
- final decision on modal host placement in the Svelte tree
- eventual test strategy for viewport fitting, centering, loading stability, and keyboard behavior

## Practical Conclusion

This should be treated as a clean replacement effort, not as a CSS cleanup.

The current implementation is valuable mainly as a source of:

- integration points
- shortcut behavior
- media-mode behavior

It should not be used as the architectural template for the new preview-modal system.
