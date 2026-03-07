# Trace-to-Profile Linking Plan (Pyroscope NodeJS Fork)

This plan defines how to get deterministic trace span -> profile linking in ArtGod by extending `@pyroscope/nodejs`.
It is intentionally implementation-ready so a future session can execute it directly.

## Goal

Make Grafana Tempo "Related Profiles" jumps resolve to non-empty, span-specific flame graphs by using:

- Span attribute: `pyroscope.profile.id = <spanId>`
- Pyroscope series label: `profile_id = <spanId>`
- Tempo mapping with `profile_id` tag enabled

Success criteria:

1. Clicking "Related Profiles" on a span opens Pyroscope with data, not empty results.
2. `profile_id` is visible as a real label in Pyroscope query APIs.
3. Label selector with `profile_id` returns samples within the trace timeframe.

## Current State (Confirmed)

- ArtGod emits `pyroscope.profile.id` on spans in `indexer/src/observability/apm.ts`.
- ArtGod wraps runtime blocks with `wrapWithLabels({ profile_id: spanId, ... })`.
- Pyroscope receives profiles and service-level labels (`service_name`, `worker`, `chain_id`).
- `profile_id` is not reliably queryable as a series label in Pyroscope Explore.
- Tempo currently maps only stable labels (`service.name`, `worker`, `chainId`) and intentionally omits `profile_id`.
- Profile type for Node workers must be `wall:cpu:nanoseconds:wall:nanoseconds` (not `process_cpu:*`).

Root issue:

- In current `@pyroscope/nodejs`, `wrapWithLabels` labels are encoded at sample level inside pprof.
- Series identity labels come from `name=<app>{tags}` in `/ingest`.
- Therefore span `profile_id` does not become a stable indexed series label by default.

## Constraints

- Keep existing behavior backward compatible for current users of `@pyroscope/nodejs`.
- Preserve ArtGod "no-op by default" observability model (`APM_ENABLED=false` remains cheap).
- Do not break heap profiling.
- Add strict guardrails for high-cardinality `profile_id` labels.

## Recommended Approach

Implement SDK-side "profile series split by sample label" in the fork:

1. During flush, read profile samples and group them by a selected sample label key (`profile_id`).
2. For each group, upload a separate profile with extra ingest tags (`profile_id=<value>`), so Pyroscope indexes it as series label.
3. Keep original aggregate upload optional (for broad service flame graphs).
4. Add per-flush caps and logging to prevent runaway cardinality.

Why this approach:

- Can be implemented in `@pyroscope/nodejs` without changing Tempo or Pyroscope server.
- Gives deterministic series labels that Grafana Tempo can select with `tracesToProfiles.tags`.
- Keeps compatibility by making the feature opt-in.

## Non-Goals (First Iteration)

- Full upstream redesign of Pyroscope query semantics.
- Perfect sample-to-span exclusivity under intense overlap; first goal is deterministic label-based linking.
- Any change to ArtGod core business logic outside observability wiring.

## Implementation Phases

## Phase 0 - Baseline and Safety Net

Deliverables:

- Freeze current behavior with a short diagnostic script and fixture profile checks.
- Add baseline docs for expected API responses before fork changes.

Tasks:

- Save baseline outputs from:
    - `POST /querier.v1.QuerierService/LabelNames`
    - `POST /querier.v1.QuerierService/Series` for `service_name=...`
    - `POST /querier.v1.QuerierService/SelectMergeStacktraces`
- Confirm `profile_id` absent in series labels pre-change (expected).

Acceptance:

- Baseline artifacts exist and can be diffed after changes.

## Phase 1 - Fork `@pyroscope/nodejs` for Series-Split Uploads

Target repository (already cloned locally):

- `tmp/repos/pyroscope-nodejs`

### 1.1 Add config surface (opt-in)

Files:

- `tmp/repos/pyroscope-nodejs/src/pyroscope-config.ts`
- `tmp/repos/pyroscope-nodejs/src/utils/check-pyroscope-config.ts`
- `tmp/repos/pyroscope-nodejs/src/utils/process-config.ts`
- `tmp/repos/pyroscope-nodejs/src/environment.ts`
- `tmp/repos/pyroscope-nodejs/src/utils/get-env.ts`

New config proposal:

- `spanProfiles.enabled?: boolean`
- `spanProfiles.labelKey?: string` default `profile_id`
- `spanProfiles.keepAggregate?: boolean` default `true`
- `spanProfiles.maxSeriesPerFlush?: number` default `100`
- `spanProfiles.dropInvalidLabelValues?: boolean` default `true`
- `spanProfiles.allowedLabelPattern?: string` default hex-safe pattern for span IDs

Notes:

- Keep this independent from existing `tags` and wall/heap configs.
- Env vars optional (for SDK users outside ArtGod):
    - `PYROSCOPE_SPAN_PROFILES_ENABLED`
    - `PYROSCOPE_SPAN_PROFILES_LABEL_KEY`
    - `PYROSCOPE_SPAN_PROFILES_KEEP_AGGREGATE`
    - `PYROSCOPE_SPAN_PROFILES_MAX_SERIES_PER_FLUSH`

### 1.2 Implement profile splitting logic

Files:

- New: `tmp/repos/pyroscope-nodejs/src/utils/split-profile-by-sample-label.ts`
- Update: `tmp/repos/pyroscope-nodejs/src/pyroscope-api-exporter.ts`
- Update: `tmp/repos/pyroscope-nodejs/src/profilers/pyroscope-profiler.ts`

Algorithm:

1. Parse pprof samples.
2. For each sample, extract string label value for `labelKey` (e.g. `profile_id`).
3. Group sample indexes by label value.
4. Enforce caps:

- truncate to `maxSeriesPerFlush`
- drop invalid values based on pattern

5. Build derived profiles for each group:

- Include only grouped samples.
- Preserve profile metadata/sample types/time boundaries.
- Optional pruning of unused locations/functions for payload reduction.

6. Upload each derived profile with extra series tag:

- `name=<app>{...,profile_id=<value>}`

7. Optionally also upload aggregate profile if `keepAggregate=true`.

Critical detail:

- Current exporter builds `name` once from static config tags.
- Refactor exporter API to accept per-export `extraTags` and combine them with base tags at request time.

### 1.3 Preserve heap behavior

- Restrict split-by-label behavior to wall profiles only.
- Heap profiles continue as aggregate-only uploads.

### 1.4 Add fork tests

Files:

- `tmp/repos/pyroscope-nodejs/test/profiler.test.ts`
- New tests around split exports and ingest query string tags.

Test scenarios:

- No split config -> current behavior unchanged.
- Split enabled with two label values -> two uploads with distinct `profile_id` tags.
- Invalid label values dropped when guard enabled.
- `maxSeriesPerFlush` cap enforced.
- `keepAggregate` true/false behavior.

Acceptance:

- All existing tests pass.
- New tests validate `name` query tags include `profile_id` where expected.

## Phase 2 - ArtGod Integration with Fork

### 2.1 Consume fork build in ArtGod

Options (pick one):

1. Temporary local file dependency during development.
2. Private fork tag pinned in `indexer/package.json`.

Requirements:

- Keep dependency in `devDependencies`.
- Keep ArtGod dynamic import behavior unchanged (`indexer/src/observability/apm.ts`).

### 2.2 Expose explicit ArtGod config toggles

Files:

- `indexer/src/config/index.ts`
- `indexer/src/config/opensea.ts`
- `.env.example`
- `.env.test.example`

New env proposal:

- `APM_SPAN_PROFILES_ENABLED=true` (already exists)
- `APM_SPAN_PROFILE_LABEL_KEY=profile_id`
- `APM_SPAN_PROFILES_KEEP_AGGREGATE=true`
- `APM_SPAN_PROFILES_MAX_SERIES_PER_FLUSH=100`

Pass these values into `initRuntimeApm` and down to Pyroscope init config.

### 2.3 Keep span attribute parity

File:

- `indexer/src/observability/apm.ts`

Ensure:

- Span attr `pyroscope.profile.id` remains set.
- `wrapWithLabels` continues to include `profile_id`, `service_name`, `worker`, `chain_id`.
- No silent fallback paths for required linking knobs when APM span profiles are enabled.

Acceptance:

- App starts with span profile mode enabled.
- No TypeScript warnings.
- No runtime exceptions during worker startup/shutdown.

## Phase 3 - Tempo and Grafana Link Re-enable

File:

- `observability/grafana/provisioning/datasources/tempo.yaml`

Changes:

- Re-enable tag mapping:
    - `key: pyroscope.profile.id`
    - `value: profile_id`
- Keep existing stable tags (`service.name`, `worker`, `chainId`).
- Keep `profileTypeId = wall:cpu:nanoseconds:wall:nanoseconds`.

Validation:

- Restart Grafana after provisioning change.
- Confirm Related Profiles jump contains `profile_id=...` in selector.

## Phase 4 - End-to-End Verification Matrix

### 4.1 Runtime checks

1. Start observability stack.
2. Start indexer workers.
3. Trigger known workload to generate spans and CPU samples.
4. Capture one trace with worker spans.

### 4.2 API checks (hard assertions)

Pyroscope:

- `LabelNames` includes `profile_id`.
- `Series` for `service_name=<worker>` includes `profile_id` on at least some series.
- `SelectMergeStacktraces` with `{service_name="...",profile_id="<spanId>"}` returns non-zero samples.

Grafana:

- Tempo span attributes include `pyroscope.profile.id`.
- Related Profiles click opens non-empty flame graph for that selector.

### 4.3 Regression checks

- Existing service-level profile exploration still works.
- Metrics and logs unaffected.
- APM disabled mode unchanged.

## Phase 5 - Hardening and Operational Guardrails

Add defensive controls:

- limit split series per flush (`maxSeriesPerFlush`)
- warn log when capping occurs
- optional drop of malformed IDs
- optional sampling gate for span profiles (future)

Add SDK and ArtGod metrics:

- `apm.span_profiles.series_created`
- `apm.span_profiles.series_dropped`
- `apm.span_profiles.flush_split_duration_ms`
- `apm.span_profiles.related_profile_hits` (optional app-side telemetry)

## Files Expected to Change

Fork (`tmp/repos/pyroscope-nodejs`):

- `src/pyroscope-config.ts`
- `src/utils/check-pyroscope-config.ts`
- `src/utils/process-config.ts`
- `src/environment.ts`
- `src/utils/get-env.ts`
- `src/profilers/pyroscope-profiler.ts`
- `src/pyroscope-api-exporter.ts`
- `src/index.ts` (if public API additions are needed)
- `src/utils/split-profile-by-sample-label.ts` (new)
- `test/profiler.test.ts`

ArtGod:

- `indexer/src/observability/apm.ts`
- `indexer/src/config/index.ts`
- `indexer/src/config/opensea.ts`
- `.env.example`
- `.env.test.example`
- `observability/grafana/provisioning/datasources/tempo.yaml`
- `docs/indexer/10-observability-and-metrics.md`

## Risks and Trade-Offs

1. Cardinality explosion:
    - One series per span can create many short-lived time series.
    - Mitigation: strict caps + optional disable in high-throughput environments.

2. Upload overhead:
    - Split uploads increase network and CPU overhead.
    - Mitigation: keep aggregate only by default, enable span split selectively.

3. Partial matching:
    - If multiple spans share one flush window, profile slices may still overlap.
    - Mitigation: acceptable for first iteration; goal is deterministic label filtering.

4. Upstream drift:
    - Fork maintenance burden as upstream SDK evolves.
    - Mitigation: keep patch minimal, isolated, and well-tested; propose upstream PR later.

## Rollout Strategy

1. Implement fork feature behind opt-in flags.
2. Validate locally in ArtGod with observability profile.
3. Enable in dev only.
4. Re-enable `profile_id` Tempo mapping.
5. Run for a few sessions and evaluate cardinality and usefulness.
6. Decide whether to:
    - keep fork private,
    - contribute upstream,
    - or keep feature disabled by default for most users.

## Rollback Plan

If any issue appears:

- Disable span profile split with env flag.
- Remove `pyroscope.profile.id -> profile_id` Tempo mapping.
- Keep service-level profile linking only (`service_name`, `worker`, `chain_id`).
- Revert fork dependency to published `@pyroscope/nodejs`.

## Open Questions for Execution Session

1. Should aggregate profile upload remain enabled when split mode is on?
2. What is acceptable `maxSeriesPerFlush` for local dev default?
3. Should we only split for specific span names (queue consumer spans) to reduce cardinality?
4. Should we enforce strict hex format for `profile_id` values?
5. Do we want this feature in offchain worker runtimes immediately, or only core sync/runtime paths first?
