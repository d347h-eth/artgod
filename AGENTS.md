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
- Keep top-level runtime flows linear and readable; separate business actions into named helpers.
- Avoid mixing unrelated concerns in one block; use clear naming and spacing.
- Follow KISS/DRY/SOLID at component and function level.
- Tests must fail fast on missing config (no silent skips).
- Treat config as required where applicable; avoid implicit defaults for critical runtime/test inputs.
- Centralize env loading in typed config modules; avoid scattered `process.env` reads.
- Do not duplicate shared constants (pagination limits, statuses, defaults, etc.) across files.
  Define once in shared config and import everywhere; no repeated magic numbers/strings.
- Prefer cursor/streamed iteration for large datasets instead of large in-memory preallocation.
- Any large in-memory allocation must be explicitly justified by business need or performance evidence.

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
