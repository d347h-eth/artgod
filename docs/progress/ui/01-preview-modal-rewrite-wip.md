# Preview Modal Implementation Record

Status: the original rewrite is complete. This file is retained as a completion
record and follow-up checklist; the canonical design remains
`docs/ui/02-preview-modal-system.md`.

## Why This Record Exists

The original preview used mixed iframe/image rendering, height-first sizing,
inline page ownership, and static viewport assumptions. Those constraints
conflicted with the required isolation and viewport-fit model, so the modal was
replaced as one system rather than incrementally restyled.

Do not use the original implementation model as a compatibility constraint.
Future preview changes must preserve the current security, ownership, sizing,
and request-state boundaries below.

## Completed Baseline

The current preview system provides:

- one root-layout modal host shared by token-browser and activity surfaces
- one controller for closed, loading, ready, and error state
- always-sandboxed iframe rendering through the shared token media frame
- a fixed fullscreen overlay independent of collection-page ancestor layout
- dynamic viewport units, safe-area insets, and contain-fit box sizing
- one persisted scale percentage in the `5..100` range
- aspect-ratio-aware width/height fitting without a fixed renderer ratio
- resize and visual-viewport observation for touch-control placement
- background document scroll lock while preview is open
- keyboard close, scale, media, and adjacent-token controls
- touch navigation with measured space for optional bottom controls
- a stable error box with an explicit retry action

The modal still treats responsive iframe documents as the first-class content
mode. Fixed-layout scaling remains future work and requires declared intrinsic
media dimensions; runtime inspection or mutation inside the sandbox is not an
acceptable substitute.

## Current Token Media Contract

Token preview no longer treats every media choice as one flat collection mode.
The state is split into:

1. collection source: `snapshot` or an extension-provided source such as `live`
2. collection preference: an optional extension-owned choice, such as
   Terraforms `always prefer V2`
3. token-local variant: the exact persisted or request-time render available for
   the current token and source

The token preview read contract returns only:

- source and preference state
- selected/default/available token variants
- `tokenId`
- effective `image`
- effective `animationUrl`

The modal displays source controls first and token-local variant controls in a
second row. It inherits source and preference from the page. Switching source
clears an explicit variant and reapplies the preference; selecting a variant
does not mutate page-level collection state.

Adjacent-token navigation carries source and preference. It also carries an
explicitly selected variant and lets the backend fall back when that choice is
unavailable on the next token. A preference-selected default stays unset in the
request so each token resolves its own default. The `V` shortcut cycles the
token-local variant while token preview is open.

## Terraforms Snapshot And Live Behavior

Terraforms snapshot preview can expose:

- `V2 artifact` from the normal V2 extension artifact
- `V2 lost terrain` from the extra lost-terrain artifact
- canonical `V2` when canonical metadata has animation media and normalized
  `Version = 2.0`
- canonical `V0` as the temporary approximation when canonical animation media
  lacks that trait, because normalized state cannot distinguish V0 from V1

The V2 artifact and canonical V2 choices can coexist. Lost terrain is always an
explicit user choice and is never auto-selected. Synthetic Terraforms tokens
have no canonical metadata and remain artifact-only.

Terraforms live preview exposes V2, V1, and V0. The backend reads current token
state from one pinned block and invokes the selected Terraforms renderer. It does
not use snapshot artifacts or the artifact lane's Daydream canvas override.

Live requests are strict request-time reads:

- no backend preview-cache hit or write
- no frontend preview-cache reuse
- no adjacent-token prefetch
- failures remain visible with retry rather than silently falling back to a
  snapshot

## Activity Preview Boundary

Activity-event preview is a separate extension contract. It keeps its existing
flat event render-mode controls and must not be forced into token
source/preference/variant semantics merely because it shares the modal host and
media frame.

## Implementation Map

- `frontend/src/routes/+layout.svelte`: shared modal host
- `frontend/src/lib/components/TokenPreviewOverlay.svelte`: overlay, controls,
  focus, scroll lock, touch gestures, and rendered request states
- `frontend/src/lib/components/token-preview-controller.ts`: preview request,
  navigation, media selection, cache eligibility, retry, and shortcut state
- `frontend/src/lib/components/TokenMediaFrame.svelte`: sandboxed iframe boundary
- `frontend/src/app.css`: viewport, contain-fit, control, and state styling
- `docs/ui/02-preview-modal-system.md`: canonical design invariants

## Verification Contract

Preview changes require rendered inspection, not only unit or component checks.
Review at representative desktop and narrow touch viewports:

- initial open and loading stability
- snapshot source with each available variant combination
- live V2, V1, and V0 selection
- source switching with the preference enabled and disabled
- explicit lost-terrain selection without automatic activation
- adjacent tokens with different variant availability
- live request failure and retry
- centered contain-fit behavior at minimum and maximum scale
- resize/orientation response and background scroll lock
- desktop two-row controls and touch layouts where the full control stack does
  or does not fit

## Practical Conclusion

The preview rewrite is no longer open work. New changes should extend the shared
controller and overlay while preserving the canonical modal invariants and the
separation between collection source, extension preference, token variant, and
activity-event render mode.
