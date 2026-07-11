# Preview Modal System

Scope: fullscreen token-media preview overlays in the userland UI.

This document defines the preview modal from first principles and should be treated as the canonical design reference for future implementation or rework.
Apply `docs/ui/00-user-perspective-and-language.md` to the complete open,
loading, navigation, error, and close journey, and use
`docs/ui/01-interaction-guidelines.md` for shared controls and page chrome.

## Goal

When a user invokes token preview, the system should render:

1. a fullscreen backdrop layer over the current viewport
2. a centered media box above that backdrop
3. a sandboxed iframe inside that box

The preview box and its iframe viewport must always fit within the visible viewport. They must not overflow outside the screen and must remain centered horizontally and vertically across viewport resize, orientation change, and device differences.

## Non-Negotiable Security Rule

Preview media must always be rendered in a sandboxed iframe.

Reason:

- preview media may come from mutable smart-contract logic
- preview media may come from IPFS or other untrusted sources
- the preview system must enforce a top-down browser isolation boundary

The preview system must not relax this requirement for convenience.

## Layer Model

Think about preview rendering as four layers:

1. viewport layer
    - the actual visible screen area
2. modal layer
    - fullscreen backdrop plus centered content slot
3. media box layer
    - the box that constrains preview size
4. iframe document layer
    - the HTML/media rendered inside the iframe

The preview system directly controls layers 1 through 3.

Layer 4 is separate and must be treated as untrusted isolated content.

## Core Invariants

These are the core invariants the implementation must preserve:

- the backdrop covers the visual viewport
- the media box never exceeds the usable viewport
- the media box stays centered on both axes
- the iframe viewport never exceeds the media box
- preview sizing is continuous and viewport-driven, not threshold-driven
- resize behavior must be dynamic and responsive
- background page scrolling should be locked while the preview modal is open
- preview layout must not depend on incidental ancestor page layout

## Sizing Model

Do not model the preview as fixed `90vw` and `90vh` CSS alone.

The correct model is:

1. measure the usable viewport
2. subtract modal padding and safe-area insets
3. apply user-selected preview scale
4. fit media into that resulting box with contain-fit behavior

The preview preference is a single scalar percent in the range `5..100`.

Interpretation:

- default = `100`
- `5` = use 5% of the usable viewport box
- `100` = use the full usable viewport box

This preference is a scale factor, not independent width and height settings.

The preview system should persist that single scalar in local storage and recompute the actual box size from current viewport dimensions on every render/resize.

## Viewport Rules

Use the visible viewport, not a stale layout viewport assumption.

Requirements:

- use dynamic viewport sizing behavior
- account for safe-area insets on mobile/notched devices
- recompute on viewport resize and orientation change
- never rely on ad-hoc width thresholds to switch layout modes

The media box should always be derived from the currently available viewport rectangle.

## Centering Rules

Centering must be explicit and owned by the modal root itself.

Requirements:

- the modal root should be the containing block for the preview
- the media box should be centered horizontally and vertically inside it
- centering should not rely on incidental margins or ancestor flow layout
- the preview should ideally render at top level, equivalent to a body-level portal

The preview system should not be vulnerable to ancestor overflow, width expansion, or unrelated page layout rules.

## Media Fit Rule

The preview system must use contain-fit behavior.

Meaning:

- media should scale down to fit both available width and available height
- no cropping is allowed by default
- no clipping outside the viewport is allowed by default

This applies to the media box and to the iframe viewport.

## Iframe Content Contract

There are two fundamentally different content modes:

1. responsive-document mode
2. fixed-layout scaled mode

### Responsive-document mode

This is the primary supported mode.

In this mode:

- the iframe document is expected to behave responsively
- the document should fit a changing iframe viewport without horizontal overflow
- the preview system only needs to size the iframe viewport correctly

This is the first-class mode the system is designed to optimize for.

### Fixed-layout scaled mode

This is the fallback/secondary mode for future support.

In this mode:

- the iframe document does not behave responsively by itself
- the preview system must still force the result to fit within the viewport
- the preview system must not defer to the document’s preferred layout width or height

Because preview media is always sandboxed in an iframe, the system must not rely on runtime DOM inspection or mutation inside that iframe.

Therefore, fixed-layout scaling must be driven from outer-box math plus known intrinsic media dimensions.

Implication:

- if fixed-layout mode is supported, the preview system needs declared intrinsic dimensions or another explicit size contract for that media
- the implementation must not assume it can inspect or repair the iframe document after load

## Implementation Guidance

The preview system should behave as if it had these responsibilities:

- manage open/close state
- manage persisted preview scale
- derive current usable viewport box
- derive current preview box from viewport box plus scale
- center the preview box
- render sandboxed iframe content inside that box

Backend/read-contract notes:

- preview modal should use a dedicated lightweight backend read contract, not the full token-detail endpoint
- preview data contract should include only media-mode state plus `tokenId`, `image`, and `animationUrl`
- preview-specific caching is allowed because the modal does not depend on ownership or market-state fields

It should not take on responsibilities that belong to the iframe document, except for enforcing outer-box sizing and future explicit fixed-layout scaling.

## Recommended UX Behavior

- open onto a dimmed backdrop
- center the preview immediately
- preserve the last chosen preview scale
- respond smoothly to resize/orientation changes
- keep the preview visually stable while loading
- keep the preview centered in loading, loaded, and error states
- do not stretch or crop content merely to fill space

## Things To Avoid

- hard-coded device thresholds as the main layout strategy
- separate persisted width and height preferences
- preview sizing that depends on ancestor layout quirks
- relying on `iframe` document internals at runtime
- assuming arbitrary iframe HTML is responsive
- allowing the preview box to exceed the visible viewport

## Required Future Clarification For Fixed-Layout Media

If fixed-layout scaled mode is implemented later, the media pipeline must define how intrinsic size is known.

Possible examples:

- extension-provided intrinsic width and height
- known renderer canvas size
- declared aspect ratio plus native render width

Without that explicit contract, the preview system can guarantee viewport-fitting iframe boxes, but not perfect fitting of arbitrary fixed-layout iframe content.
