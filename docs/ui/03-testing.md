# UI Testing

UI verification has four layers. Each owns a different kind of confidence; no
single layer replaces the others.

## Static and Unit Tests

Svelte/TypeScript checks catch component contracts, helper behavior, request
mapping, state transitions, and accessibility regressions without launching a
browser.

```sh
yarn workspace @artgod/frontend check
yarn workspace @artgod/frontend test
```

Keep business behavior in shared components/helpers and test it there. A route
test should not copy pricing, media, filtering, pagination, or selection logic.

## Deterministic Playwright Harnesses

Dedicated fixture-backed routes under `/e2e-harness` render production
components with compact typed data. Collection bidding and Terraforms media use
`/e2e-harness/collection`, authorization uses `/e2e-harness/admin/bots`, and
bootstrap coverage uses `/e2e-harness/bootstrap-runs`. The harnesses do not run
OpenSea, the bidding bot, or depend on whichever rows happen to be in the
developer's SQLite database.

The harness is appropriate for:

- bidding target gestures, drafts, panel state, tiers, price fields, and outgoing
  request shapes;
- public read-only guardrails;
- bootstrap probe states;
- token preview source/variant behavior;
- Terraforms media and Hypercastle interactions.

Current repository commands include:

```sh
yarn test:bidding:automation
yarn test:bidding:automation:public
yarn test:bidding:authorization
yarn test:bootstrap:probe
yarn test:terraforms:media
yarn test:terraforms:hypercastle
```

Use accessible roles and names first. Add a domain-named `data-testid` only when
repeated controls cannot be selected unambiguously. Avoid assertions against
volatile CSS internals unless geometry itself is the contract.

### Bidding Scenario Ownership

`frontend/e2e/bidding-automation.spec.ts` covers the settled user interactions
across token browsers, token-offer scope, trait buckets, collection scope, token
detail, automation panel states, and price-tier management. The public spec
proves that offer reads remain visible while jobs, tiers, and mutation controls
do not.

Important boundaries:

- token-card selection gestures must not hijack token-ID or price links;
- filtered/all/page/exact selection must produce distinct typed API intent;
- trait bucket filtering and bidding are separate actions;
- collection bid rows do not gain row-level placement actions;
- create, modify, activate, pause, archive, and double-confirm states are tested
  independently from the page that opened the panel;
- fixture amounts and assertion names use human-readable Ether; persistence/EVM
  conversion remains backend/trading coverage.

## Attached-App Smoke Tests

Attached suites run against an already-started local application. They are kept
small because real database contents and runtime state are intentionally not a
stable exhaustive fixture.

Use attached coverage for:

- hydration and route reachability;
- critical geometry in the real composition;
- a small representative interaction that can reveal wiring drift.

```sh
yarn dev
yarn test:preview:attached
yarn test:bidding:attached
```

Headed and artifact variants are exposed by the corresponding package scripts.
Do not expand attached smoke into a duplicate of deterministic coverage.

## Rendered Inspection

Automated assertions cannot establish the complete user-perspective reading
order, visual hierarchy, clipping, touch fit, or whether error recovery is
understandable. Every user-visible change still requires inspection of all
material states at representative viewports, following
[User Perspective and Language](00-user-perspective-and-language.md) and
[Interaction Guidelines](01-interaction-guidelines.md).

Use the project-owned Playwright harness for repeatable WebView/browser states.
Do not create ad hoc scripts that inspect the host display server, synthesize
system input, or capture unrelated native windows. If no maintained native
harness exists and building one is outside scope, leave native rendered QA to
the user and report the gap.

## Failure Diagnostics

Suites that install the shared E2E diagnostics helper attach browser console
errors and page errors when a test fails. Playwright configuration and
individual specs retain or attach screenshots, traces, video, and other
artifacts according to each suite's policy. Preserve those diagnostics when
adding a new suite. Expected product failures should be asserted through their
user-visible action and recovery; raw transport details belong in logs, not in
screenshot text.

## Current Limits

- Playwright covers web and WebView behavior, not native secret-prompt rendering.
- Attached tests prove a thin integration path, not exhaustive correctness over
  live marketplace or chain state.
- Marketplace placement, WETH approval, cancellation, and bot reconciliation
  belong to backend/trading tests and native boundary tests, not UI fixtures.
