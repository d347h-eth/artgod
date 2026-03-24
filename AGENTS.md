# AGENTS.md

This file is agent-specific guidance.
Project/product status and architecture are canonical in `README.md`.

## Read Order

Before making substantial changes, read these sections in `README.md`:

1. `Canonical Status`
2. `Architecture Overview`
3. `Indexer Runtime Topology`
4. `Core Invariants`
5. `Bootstrap Lifecycle`
6. `Database & Migrations`
7. `Canonical Docs`

For implementation details, use:

- `docs/indexer/00-overview.md` through `docs/indexer/14-collection-bootstrap.md`
- `docs/progress/indexer/15-unified-backlog.md`

## Agent-Only Rules

- Do not duplicate project status text from `README.md` into this file.
- Do not introduce user-specific absolute filesystem paths in docs or code comments.
  Prefer workspace-relative paths or environment variables.
- Always plan and implement new code using Hexagonal Architecture (Ports & Adapters).
- Keep top-level runtime flows linear and readable; separate business actions into named helpers.
- Avoid mixing unrelated concerns in one block; use clear naming and spacing.
- Follow SOLID principles at component and function level.
- Follow KISS/DRY at component and function level.
- Tests must fail fast on missing config (no silent skips).
- Treat config as required where applicable; avoid implicit defaults for critical runtime/test inputs.
- Centralize env loading in typed config modules; avoid scattered `process.env` reads.
- Do not duplicate shared constants (pagination limits, statuses, defaults, etc.) across files.
  Define once in shared config and import everywhere; no repeated magic numbers/strings.
- Prefer cursor/streamed iteration for large datasets instead of large in-memory preallocation.
- Any large in-memory allocation must be explicitly justified by business need or performance evidence.
- For frontend layout, default forms, tables, and configuration surfaces to compact, fit-to-content widths and center them horizontally.
  Do not stretch UI elements to `100%` width unless the user explicitly asks for a full-width layout.

## Domain Modeling

- Treat business rules as domain behavior, not stringly-typed application logic spread across consumers.
- Keep raw persistence/serialization literals private to the relevant domain module whenever possible.
  Callers should not branch on hard-coded strings, status values, kind values, or internal flags that belong to one domain model.
- Expose explicit domain contracts for business decisions.
  Prefer methods and named helpers such as `isX()`, `canY()`, `matchesZ()`, `resolveScope()`, or other intention-revealing APIs instead of leaking internal rule details into callers.
- Distinguish clearly between serialized/storage shapes and domain/business objects.
  Serialized shapes exist for adapter boundaries; domain objects exist to protect invariants and expose behavior.
- When a domain concept has declared state and downstream/materialized state, model both explicitly instead of implicitly collapsing them into one table or one flag.
- If multiple consumers need the same rule, move that rule into the domain type instead of duplicating conditionals across workers, use cases, adapters, or tests.
- Keep validation and invariant enforcement close to the domain constructor/factory so invalid raw data is normalized or rejected before wider use.
- Use collection token scope as the reference example for this rule:
  raw values like `contract_all_tokens` should stay internal to the collection domain module, while callers should use explicit APIs such as scope predicates, token membership checks, and range intersection helpers.

## Backend Hexagonal Guide

These rules are mandatory for backend planning and code generation.

### 1) Core model and ports

- Use cases are the application core.
- Use cases are concrete classes (not factory-returned closures by default).
- Each use case class defines:
    - exported input/output shapes (core boundary contract)
    - constructor-injected outbound ports it drives
    - explicit public methods that implement business behavior
- Port signatures must use use-case-local/core types.
- Do not expose framework/transport/driver types in use-case APIs.

### 2) Port ownership and placement

- Outbound ports should be local to each use case module (constructor types/aliases/interfaces).
- Do not centralize outbound ports in a common `ports/*` folder unless clear cross-use-case reuse is proven.
- Inbound adapters (HTTP) define their own driven-port contracts locally per adapter.
- Inbound adapter driven ports should be embedded directly in adapter constructor signatures unless reuse justifies extraction.
- Adapters implement translation/transport concerns; they do not define core business behavior.

### 3) Dependency direction (strict)

- Inbound adapters (HTTP) depend only on use-case public methods and exported input/output contracts.
- Use cases depend only on domain + outbound port interfaces.
- Outbound adapters depend on infra/SDK/DB details and implement outbound ports.
- Adapters must not call adapters directly (e.g. HTTP -> DB adapter is forbidden).

### 4) Import matrix (enforced)

- `application/*` -> may import `domain/*` + outbound port interfaces; must not import `http/*` or concrete adapters.
- `http/*` -> may import use-case classes + exported input/output contracts + `http/common/*`; must not import concrete DB/RPC adapters.
- Outbound adapters -> may import infra libs + outbound port interfaces.
- Composition root -> may import everything needed for wiring.

### 5) Composition root

- Keep composition centralized (backend startup/wiring path).
- Wire in order:
    1. create outbound adapters
    2. instantiate use-case classes with outbound ports
    3. inject use-case instances into inbound adapters explicitly one by one
    4. register inbound routes
- Only composition root knows concrete adapter implementations.
- Do not introduce dependency container objects (e.g. `*Dependencies`, `ApiRouteDependencies`) when explicit parameters are sufficient.

### 6) Adapter boundaries

- Routes: path/method registration only.
- HTTP adapters: map transport DTOs -> use-case input, call use-case method, map output -> transport response.
- HTTP common: parsing, validation helpers, headers, error mapping.
- Business orchestration belongs in use cases, not route/handler registration.

### 7) DTO and model boundaries

- Protocol DTOs (query/path/body/reply) are adapter-local.
- Use-case input/output models remain transport-agnostic.
- Avoid leaking SQL rows, SDK payloads, or framework request/response objects across boundaries.

### 8) Transaction and consistency boundaries

- If a use case needs atomicity/transaction scope, define it via an outbound port contract.
- Do not place transaction orchestration in HTTP handlers.

### 9) Structure and scaling

- Organize by subject/use case.
- Preferred backend structure:
    - `application/use-cases/<subject>/*`
    - `http/handlers/<subject>/*`
    - `http-routes.ts` (single HTTP route registration module near `http-app.ts`)
    - `http/common/*`
- Keep one file per use case and one handler per route/use-case entry where practical.

### 10) Extension workflow

- For new behavior:
    1. define/adjust use-case input/output and method
    2. define/adjust local outbound ports in that use case
    3. implement/update outbound adapters
    4. wire use-case class instance in composition root
    5. expose via inbound adapter mapping
    6. add/adjust tests

### 11) Testing strategy

- Use-case tests: unit tests with mocked outbound ports; no Fastify/HTTP dependency.
- HTTP adapter tests: request/response mapping and error-shape checks via `app.inject()`.
- Integration tests: wire real adapters only when validating full vertical behavior.

### 12) Anti-patterns (forbidden)

- Inbound handlers importing concrete DB/RPC adapters.
- Use-case signatures leaking framework/transport/driver types.
- Shared “god” dependency objects passed to modules that do not need most fields.
- Business logic hidden in route registration files.
- Duplicated adapter-specific parsing/constants across handlers.

### 13) Concrete conventions

- Prefer concrete classes for use cases and HTTP adapters.
- Prefer positional constructor/factory arguments over `*Dependencies` object wrappers unless there is a strong reason otherwise.
- Do not introduce grouped adapter containers/builders that instantiate multiple adapters at once; compose adapters one by one explicitly in the composition path.
- Do not introduce grouped route-registration modules per subject when a single `http-routes.ts` can register routes explicitly.
- Export by default only core use-case input/output shapes and class.
- Keep other helper types local unless cross-module reuse is real.
- Use small explicit mapping functions/methods at adapter boundaries (`transport -> core -> transport`), even when currently identity.

## Architecture Constraints

- No centralized ArtGod servers.
- Backend/workers/database run locally on the user's machine.
- Network communication should be peer-to-peer and/or public blockchain/marketplace APIs.
- Preserve offline-capable behavior where feasible.

## Skills

A skill is a set of local instructions in a `SKILL.md` file.

### Available skills

- `skill-creator`: Guide for creating/updating skills.
  File: `$CODEX_HOME/skills/.system/skill-creator/SKILL.md`
- `skill-installer`: Install curated or repo-based skills.
  File: `$CODEX_HOME/skills/.system/skill-installer/SKILL.md`

### Skill usage

- Trigger: Use a skill when user names it or task clearly matches it.
- Loading: Open only what is needed from the skill docs/references.
- Missing skill: State briefly and continue with best fallback.
- Keep context lean: avoid bulk-loading unrelated skill references.
