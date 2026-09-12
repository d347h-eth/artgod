# AGENTS.md

Agent-specific guidance. Project overview and documentation navigation belong in
`README.md`.

## Scope and authorization

- Do not edit files on `main` or `dev` unless the user explicitly overrides this
  restriction. Honor expressly permitted read-only work on those branches.
  Create or switch branches/worktrees only on direct user instruction.
- Investigation, analysis, review, and report requests are diagnostic-only unless
  implementation is explicitly authorized. Symptoms, logs, screenshots, and
  queue output alone do not authorize edits or remedies. Report evidence,
  uncertainty, and proposed next steps. Branch/worktree preferences alone do not
  authorize implementation.
- For authorized implementation, carry the requested change through relevant
  verification, correcting failures caused by the change without repeated
  approval. Make routine implementation decisions within scope; respect
  review-first stopping points and explicitly excluded files or workflows.
- Ask when a required decision or permission is missing; continue independent
  authorized work. If guidance blocks progress, cite its file and exact
  instruction and explain what remains unresolved.
- Keep machine-specific filesystem paths out of code, comments, and tracked
  documentation. Use workspace-relative paths or environment variables.

## GUI automation safety

- Do not create or run ad hoc scripts that capture, inspect, or control host GUI
  windows through system/display-server APIs, X11/Wayland, or driver-level input.
- Automated GUI coverage must use a maintained, project-owned harness: Playwright
  for web/WebView flows, or an appropriate native framework. Keep test code
  reusable and reviewable in the repository, run through a documented command.
- Creating or extending a harness is implementation work and requires that scope.
  If no suitable harness exists, defer rendered inspection to user QA and report
  the gap; do not improvise host-display automation.

## Engineering judgment

- Evaluate requested approaches and existing patterns for concrete architectural
  or correctness problems. Explain material objections and apply corrections to
  the actual defect. Existing design can evolve as features develop.
- Reuse abstractions that fit; improve unsuitable ones within the authorized
  scope. Explain consequential departures from local conventions. Engineering
  discretion applies to design choices within authorization, safety, and domain
  invariants.
- ArtGod has no centralized servers: backend, workers, and database run locally.
  Use peer-to-peer communication and/or public blockchain/marketplace APIs, and
  preserve offline-capable behavior where feasible.
- Prefer cursor/streamed iteration for large datasets; justify large allocations
  with business need or performance evidence.

## Context and skills

Read only what the current task needs, using these entry points as relevant.

- Use `README.md` for orientation and its Documentation Map for component docs.
- Use `docs/project/01-public-alpha-scope.md` for feature-scope decisions.
- Use `docs/development/01-local-development.md` for setup and local verification.
- For indexer work, use `docs/indexer/00-overview.md` to locate relevant design
  guidance and `docs/progress/indexer/15-unified-backlog.md` for planned work.
- Before UI changes, consult the relevant guidance in
  `docs/ui/00-user-perspective-and-language.md` and
  `docs/ui/01-interaction-guidelines.md`.
- Use a skill when the user names it or its specific workflow fits the task.
  Load only relevant supporting resources. Skill guidance must respect the
  user's explicit scope and authorization.
- Add a skill only when a recurring workflow benefits from reusable guidance
  beyond these conditional sections. Keep its trigger precise and its body
  limited to useful constraints, outcomes, and references.

## Domain and contract ownership

- Put business rules and validation in the owning domain model. Expose named
  behavior for business decisions; keep raw persistence/serialization values
  private when callers can use that behavior. Model declared state separately
  from downstream/materialized state when both exist.
- Define semantic contract values once in the owning domain, adapter, extension,
  or config module. This includes vocabulary another module, test, UI, or
  operator must recognize: statuses, events/actions, metrics/log labels,
  routes/parameters, config/query/cache/storage keys, protocol labels, and UI
  state/selector tokens. Export constants when consumers need that vocabulary;
  otherwise expose the owner's behavior. Resolve ownership within the requested
  change before introducing a value.
- This applies across production code, tests, fixtures, scripts, config,
  observability, and documentation defining code contracts. Tests consume the
  same public constants/contracts unless deliberately asserting wire or storage
  serialization at the boundary.
- Keep ordinary fields, properties, method names, variables, and language syntax
  readable. Centralize a field name only when it is shared wire vocabulary and
  doing so clarifies the boundary contract.
- Keep collection-specific values and rules inside their extension. Generic
  modules consume extension-provided data through generic contracts; they must
  not import extension-specific constants or move them into shared/core.
- Load environment configuration through typed config modules. Required runtime
  and test inputs must fail clearly when absent; do not hide missing config with
  defaults or skipped tests.
- Comment non-obvious intent, constraints, and behavior, including public
  contracts and port calls when their purpose needs explanation.

## Backend changes

Apply SOLID and Ports & Adapters consistently to keep business behavior
independent of transport and storage. Preserve domain/use-case ownership and
dependency direction as the implementation evolves:

- Keep responsibilities focused, interfaces narrow, and implementations faithful
  to their contracts. Extend behavior through the owning abstractions while
  keeping business rules in their domain.
- Use cases own business orchestration and depend on domain models and injected
  outbound ports. Their input/output contracts must not expose HTTP, SQL-row,
  SDK, or driver types.
- Inbound adapters map transport input to use-case input, call the use case, and
  map its output to a response. They must not call concrete DB/RPC adapters.
  Keep route registration focused on paths/methods and handler registration.
- Outbound adapters implement core ports and own persistence, RPC, and SDK
  translation. Keep transaction requirements in use-case port contracts.
- Construct and wire concrete adapters and use cases in the composition root.
  Inject only collaborators each consumer needs; keep the business flow linear
  and readable, with helpers for distinct actions.
- Prefer use-case-local outbound ports and adapter-local inbound contracts.
  Share contracts when reuse is established; export only what consumers need.
- Choose classes, functions, and file organization to fit the behavior and
  surrounding code while preserving these boundaries. Add an abstraction only
  for a concrete responsibility or variation.

## UI changes

- Verify the affected journey from entry through action, result, and recovery.
  Review the whole affected rendered surface in reading order, including all
  materially different states at a representative viewport. Automated checks
  alone do not replace rendered inspection. For screenshot reproduction, read
  the image's actual dimensions.
- Use product/task language. Show recognizable names before qualified technical
  IDs. Keep quantities explicit about units and scope, and ratios about their
  denominator; distinguish limits per NFT, offer, transaction, or cumulative.
- Keep expected errors brief and actionable, with the exact recovery action.
  Leave transport/internal detail in logs and do not present an unknown failure
  as a known cause.
- Keep setup, prompts, active states, validation, and errors consistent across
  Admin and Userland. Security-sensitive review must show the canonical identity
  and limits that enforcement receives.
- Default forms, tables, and configuration to compact, fit-to-content widths,
  centered horizontally, with controls in compact left-aligned groups. Use
  full-width layouts or far-right controls only when requested.
- Reuse existing control families for established interactions. For authorized
  new interactions, choose appropriate controls within the existing visual
  system and interaction conventions.
- Use the UI chrome colors owned by `frontend/src/app.css`: `--c-bg`,
  `--c-cyan`, `--c-blue`, `--c-pink`, `--c-sand`, `--c-ice`, `--c-yellow`,
  and `--c-orange`. Do not add raw colors or feature-local palettes. Normal links
  are cyan, hover/focus yellow, and selected/active states orange.
- Keep labels and controls compact; avoid redundant explanatory copy. Do not
  expose placeholder or unimplemented capabilities.

## Verification and handoff

- Choose checks for the changed behavior and its risks; complete required
  repository checks. Add tests when they verify meaningful behavior or
  invariants, rather than mirroring implementation or wording.
- Select backend test coverage for the behavior and boundary being changed.
  Examples include isolated domain/use-case tests with test doubles, HTTP
  mapping/error checks through `app.inject()`, and integration tests with real
  adapters.
- Once affected checks and required gates pass, broaden or repeat verification
  only for new changes, failures, or unresolved concerns. Authorization for local
  checks does not extend to unrequested changes to live or shared data.
- Report the result, relevant verification, and remaining gaps concisely.
  Distinguish confirmed evidence from inference and unverified behavior.
