# User-Perspective UI and Product Language

Scope: every user-visible ArtGod surface, including Userland, Admin, native
secret prompts, loading and empty states, validation, errors, and operator
status output.

Read this document before `docs/ui/01-interaction-guidelines.md`. The interaction
guide owns established layout and control patterns. This document owns how a
surface is understood from the user's point of view.

Domain-specific companions:

- `docs/trading/02-bidding-automation-capabilities.md` for bidding workflows
- `docs/desktop/03-wallet-keystore-and-bot-unlock.md` for native wallet prompts
- `docs/ui/02-preview-modal-system.md` for token preview behavior

## Non-Negotiable Outcome

A UI change is not complete merely because the component renders and its event
handler works. Looking at the complete surface, the user must be able to answer:

1. Where am I and what am I looking at?
2. What exact object, network, collection, wallet, or process is in scope?
3. What can I do here?
4. What unit, denominator, time range, or lifecycle does each value use?
5. What will happen if I act?
6. What happened after I acted, and what must I do if it failed?

The user must not need to know ArtGod's adapters, DTOs, process boundaries,
storage layout, or internal threat-model vocabulary to interpret the UI.

## Required User-Eye Review

Before implementation, state the concrete user journey:

1. identify the user and their goal
2. identify the exact entry state and surrounding page context
3. walk each observation and required action in order
4. include loading, empty, disabled, validation, error, success, and active states
5. identify what the user needs to compare before deciding
6. identify the recovery action for every expected failure

After implementation, repeat the same journey against the rendered UI. Read the
whole screen in visual order rather than reviewing a new component in isolation.
Adjacent headings, status blocks, controls, and errors form one explanation and
must make sense end to end.

Do not use helper prose to repair a vague label. Fix the label, grouping, value,
or information order first. Add explanatory copy only when the concept genuinely
cannot be made clear through compact product language.

## Information Order

Present information in the order a user needs it to decide:

1. human-recognizable context
2. explicitly qualified technical identity
3. current or proposed lifecycle state
4. exact scope and limits
5. available action
6. result or recovery

Use the human name before a numeric or opaque identifier. Qualify every ID so it
cannot be mistaken for a collection ID, database ID, token ID, or chain ID.

Good:

- `Ethereum · chain ID #1`
- `terraforms · ArtGod collection ID #1`
- `OpenSea slug: terraforms`
- `contract address: 0x...`

Bad:

- `chain 1`
- an unexplained `#1`
- `OpenSea: terraforms` when the value is specifically a slug
- `contract: 0x...` when the value is specifically an address

When the canonical name is unavailable, show a correctly qualified identifier.
Never attach a guessed name to an ID or maintain a feature-local ID-to-name map
when canonical chain or collection context already exists.

## Product Language

Use the user's task and domain as the vocabulary source. Internal implementation
terms belong in code, logs, and technical documentation unless the distinction is
itself something the user must understand to act safely.

Avoid unexplained terms such as:

- native
- payload
- DTO
- row
- adapter
- snapshot
- projection
- mandate

`native wallet prompt` is meaningful when distinguishing the trusted desktop
prompt from WebView UI. `native collection mandate` is not meaningful product
language for choosing bidding permissions. Preserve precise security terminology
in internal design documentation while translating the user-facing workflow into
terms such as `bidding authorization request` and `active bidding authorization`.

Lifecycle labels must distinguish proposed, pending, active, stopped, failed, and
historical state. Do not label a draft as active or make a prior authorization
look like current authority.

## Units, Scope, and Denominators

Every user-facing amount or limit must state:

- unit
- denominator or scope
- whether it applies per action, per item, per order, or cumulatively

Good:

- `max WETH for any one NFT`
- `max NFTs per offer`
- `approval max gas fee`
- `offer expiration seconds`

Bad:

- `max quantity`
- `max WETH / NFT` when plain language is clearer
- `limit`
- an amount without a currency

Do not imply cumulative protection when enforcement is per offer, per job, or per
transaction. If two values combine, their labels must let the user understand the
result without reading source code.

## Errors and Recovery

Expected user-facing errors must be concise and actionable. Prefer the shortest
message that tells the user what to do next.

Rules:

- map a known failure to the exact action or control that resolves it
- use the same action wording as the UI
- do not expose raw loopback URLs, request-library text, stack traces, or transport
  internals as the primary message
- retain technical detail in logs when it is useful for diagnosis
- do not claim a cause that was not established; preserve distinct messages for
  rejection, invalid data, and unavailable infrastructure
- keep the current safe state visible when recovery is possible

Example: a connection failure to the local collection catalog can say
`Start infra to prepare bidding authorization.` Local bot state and wallet
assignment remain available. An HTTP rejection or invalid response is a
different failure and must not be mislabeled as stopped infrastructure.

## Cross-Surface Consistency

One user action may cross Userland, Admin, a native prompt, runtime status, and an
error path. Review all of them together.

The same concept must keep the same:

- human name
- qualified identity
- unit and denominator
- scope
- lifecycle terminology
- proposed and active values

For security-sensitive approval flows, the review surface must display the exact
canonical values that enforcement receives. The setup surface, trusted prompt,
and active-state summary should read as one lifecycle, not three unrelated data
models.

## Capability Honesty

Render only capabilities that actually exist and that the user can meaningfully
operate. Do not expose staged, placeholder, or nonexistent process panels merely
because a runtime enum or future plan exists.

Disabled controls are appropriate when the capability exists and the missing
prerequisite is visible. Remove UI for nonexistent capabilities instead of
presenting unexplained `unavailable` states.

## Visual and Control Reuse

Before adding markup or CSS:

1. inspect the nearest equivalent surface
2. inspect `frontend/src/app.css` for the established class family
3. inspect the bootstrap form, bidding panel, and existing Admin configuration or
   wallet controls when working on forms or operator panels
4. reuse the established control, input, selection, action-polarity, spacing, and
   focus behavior

Do not ship raw browser-default inputs, one-off fieldsets, alternate checkbox
families, new button styles, or feature-local palettes when the application
already owns that interaction.

Follow `docs/ui/01-interaction-guidelines.md` for the detailed style and layout
contracts.

## State and Viewport Verification

Inspect every materially different visual state:

- initial loading
- empty data
- disabled prerequisite
- editable default
- selected or enabled controls
- validation failure
- infrastructure or request failure
- in-progress action
- successful active state
- narrow and representative desktop widths

Use the actual dimensions of a reported screenshot or artifact when reproducing a
layout. Read image metadata; do not round, infer, or present a test-harness size as
the source image size.

Automated type checks and unit tests do not replace rendered inspection for UI
work. Verify alignment, wrapping, input chrome, disabled appearance, focus and
active states, and the full reading order in a real render or faithful harness.

## Review Evidence

A UI handoff should state:

- the user journey and states reviewed
- the existing components/classes reused
- the representative viewport or artifact inspected
- the automated checks run
- any residual ambiguity or unsupported state

Do not claim a viewport was exact unless it was measured, and do not claim a flow
is clear without reading it from entry state through completion or recovery.

## Documentation Navigation

- `AGENTS.md`: mandatory agent workflow and stop-the-line UI rules
- `docs/ui/00-user-perspective-and-language.md`: user-eye reasoning, product
  language, identity, units, errors, and verification
- `docs/ui/01-interaction-guidelines.md`: established layout, component, control,
  navigation, and style contracts
- `docs/ui/02-preview-modal-system.md`: preview-specific security and sizing
- `docs/trading/02-bidding-automation-capabilities.md`: bidding workflow and UI
  capability semantics
- `docs/desktop/03-wallet-keystore-and-bot-unlock.md`: native prompt trust boundary
  and wallet/bot approval flow
