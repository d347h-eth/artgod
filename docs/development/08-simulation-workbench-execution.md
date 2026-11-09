# Simulation Workbench Execution

Updated 2026-11-09. The workbench and five qualification follow-ups have a fresh
full-build local execution at source `0fc446b4`. All 26 cases pass strict machine
replay; ten retain failed properties. This guide describes the tooling contract;
source commands and retained reports own execution evidence. Read the
[strategy](06-deterministic-system-testing-strategy.md) and
[scenario catalog](07-deterministic-system-testing-scenarios.md) before adding
workloads.

## Current Local Evidence

The final sealed cohort is `tmp/simulation-qualification-closure/cohorts/cohort-shGmQp/`.
Its `plan.json`, four lane results, `closed.json`,
`assessment-e0OpwA/assessment.json` and `root-reconciliation.json` account for
all 26 declared cases. The executable source and controller stayed frozen at
`0fc446b416a5e84f0ec46b1dbdbb123ae24dbeb0` throughout. There were 26 actual record
phases and 26 replay phases, with no missing cases, interruptions, retries or
waivers. Every pair passed engine qualification, exact serial equality and
complete guest-visible disk capacity/byte comparison. Property outcomes are
separate:

| Lane                           | Executed | Passed | Failed |
| ------------------------------ | -------: | -----: | -----: |
| Named regressions, shard 1     |        7 |      5 |      2 |
| Named regressions, shard 2     |        7 |      4 |      3 |
| Held-validation command orders |        6 |      4 |      2 |
| Header-error command orders    |        6 |      3 |      3 |
| Total                          |       26 |     16 |     10 |

The fresh full guest is `tmp/simulation/guest-oGbmdb/manifest.json`. Before the
cohort, all 429 supporting tests passed with zero skips, as did formatting and
documentation verification over 83 Markdown files. Actual M0 `run-0fjk8A` passed all eight checks and
strict serial/disk replay in 210.990 seconds. Separate native-context probe
`run-gv0TBU` passed capture and strict replay in 167.811 seconds; independent
GNU/elfutils/Python inspection qualified the raw/derived ELF notes, bounded
memory bytes and corrected load alignment. These are specific substrate and
capture checks, not proof of every runtime computation.

The ten failures remain failed:

- Seven actual `SIGSEGV` exits (six domain workers and one sync worker) are typed
  runtime-liveness failures. They leave the intended histories partly or wholly
  unreached; inherited unfinished HTTP/reorg flags do not establish separate
  business defects. No captured instruction ties these runs to the earlier
  independently located V8 fault, whose corruption origin remains unknown.
- `run-nzvHtB` and weighted/default-budget `run-eMVZMt` reach fresh full validation
  and settle with healthy actors. Actual A104 header → B104 numeric ownership
  read → A104 header observations produce a Fillable listing and a 1 WETH HTTP
  ask while canonical persisted ownership belongs to the buyer. Their current
  source revision, generation, time requirement and proof coverage pass. This
  is a snapshot-coherence counterexample, not an old-cache or missing-floor
  assertion. See `BKL-078` in the [backlog](../planning/01-unified-backlog.md#simulation-findings).
- `run-KqgnDf` stops all ten actors and reaches both successful real maintenance
  artifacts. Two completed proof rows disappear while the same canonical orders
  survive with unchanged selected fields, before any actor restart. This proves
  lost saved coverage; pending-work loss, wrong fillability and subsequent
  cancellation/authority checks are unproved. See `BKL-079` in the same backlog.

Seven of twelve causal histories completed every owning-model requirement.
Four native-blocked histories never reached the old-validation prelude; held
EVRS reached all four external commands and canonical B before a domain crash
prevented settlement. Neither that prefix nor merely executing all twelve
cases earns complete-history or dedicated stale-guard credit.

The proof audit observes all required revision, `required_at`, `minimum_block`
and coverage fields in 158 observations of projected proof rows across
checkpoints, with none absent. These are not 158 distinct proofs. Every observed
`minimum_block` is explicitly null. Positive numeric block-floor acceptance and
rejection are verified by supporting tests, not by these E2E captures. Stored
older-chain coverage, witnessed new work and terminal endpoints retain their
separate contracts:

- Committed-validation v2 `run-rxXoQL` witnesses an actual pre-rollback
  unattributed cancellation and retains it after revision advance. This earns
  strong retention only.
- Weighted-fork v2 `run-FGIdjG` passes actual fair recovery and canonical
  acquisition/debt closure in 415.403 seconds. The split retains A105 as
  ineligible at head 106/depth 3; B107 makes it eligible. Explicit healing is
  sequence 505. Before E's rollback-wait acknowledgement at sequence 563,
  its nested input snapshot records the started producer and fresh B111.
  Final B111 has empty business-debt arrays and only recent checks 110/111.
  It exercises the separately
  permitted unattributed-cancellation endpoint, supported by a real A105
  counter-one computation before explicit healing. The SQL commit timing was
  not observed; its retention, stale-rejection and current-executable-bid-proof
  credit flags are all false. Other order and canonical assertions remain.
- VM stale-cut v2 `run-GpyieB` crashes in the domain worker after the A-sale
  prefix, before counter capture. Its reached map is empty: no restart,
  rollback-cut, rejection or fresh-proof credit is assigned.

A separately authored, real native whole-runtime stale-v2 control,
`control-ybwIwy`, passes all seven checks in 67.503 seconds. The real reorg worker
restarts while the domain worker and original ten-second RPC deadline remain
unchanged. The exact old lease is refused, newer source work stays pending,
then a fresh proof and HTTP state converge. This is native-only evidence; it
does not clear the VM failure, qualify uninterrupted worker timing, or exhaust
finish-to-SQL interleavings. The earlier warm-v1 window miss remains unreached
and unchanged.

Final-source full/coordinator-reuse logical equivalence passes all 7,843 image
entries, 546 payload pins, 1,165 source inputs, 630 coordinator inputs and helper
readbacks. The known coordinator UID/GID/xattr difference remains explicit;
whole-filesystem metadata equality is not claimed. The independent-copy genuine
failed-counterexample replay described below also passes strict serial/disk
comparison with original pins/inodes preserved. Evidence and independent audits
are indexed by the cohort's `handoff.json`.

The cohort took 2,840.506 seconds locally (47.34 minutes), with at most four
simultaneous VMs. Pair elapsed times range from 288.977 to 546.980 seconds,
median 363.1705 seconds; the slowest lane sums to 2,740.951 seconds. Top-level
paired-run files allocate 2,306,621,440 bytes, excluding reusable guests,
capsules, case inputs and other retained diagnostics. Each VM is configured
with one vCPU and 2 GiB. These shared-host measurements neither measure host
peak memory nor qualify hosted budgets or multicore race coverage.

| Milestone | Demonstrated boundary and remaining limit                                                                                                                                                             |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0        | Fresh full guest, eight-check substrate and separate capture probe qualify this specific execution profile. Unexplained runtime crashes still limit confidence beyond those checks.                   |
| M1        | Production marketplace → validation → actual fork recovery → HTTP journeys run. Final VM retention is witnessed; the dedicated stale cut is demonstrated natively and remains VM-blocked.             |
| M2        | Authored disagreement, lag, actual weighted free-RPC routing, refusal and process/broker restarts run. Commit-before-ACK, uncertain publication and additional partition variants remain unqualified. |
| M3        | Every declared named case and bounded causal order is accounted for; seven causal histories complete. Strict CI lanes and artifact owners exist; hosted execution/retrieval is blocked.               |
| M4        | Actual bootstrap pause/reopen/retry/completion runs. Maintenance discovers retained-coverage loss before later checks; bot authority and extension-trigger journeys remain unqualified.               |

The scenario catalog remains broader than this corpus. Further current-system
coverage includes SC-04 WS/HTTP and reverse-head variants, SC-06 archive/hash/revert
variants, SC-09 production commit-before-ACK, SC-10 publication ambiguity, SC-11
cursor/lease cuts, SC-13 REST traversals, SC-15 positive block-floor E2E work,
SC-17 boundary matrices, SC-21 ERC1155/burn/sentinels, SC-22 retention, SC-24 bot
authority and SC-25 extension triggers. Future P2P/multisource/multichain behavior,
rendered desktop/release qualification and arbitrary-host portability are not
implemented or qualified here.

The five follow-ups' [final disposition](09-simulation-qualification-closure.md#final-disposition)
keeps native-origin/profile qualification and hosted CI partial. The current
corpus and default CI property gate remain red, with no expected-failure waiver.
GitHub read-only checks confirm repository access, but SSH authentication fails
and the OAuth scopes omit `workflow`; no successful publication, PR, hosted run
or merge is claimed. This is a reviewable problem-finding baseline, not green
release qualification or replacement for all manual QA. Subsequent documentation
commits do not claim a rerun of executable source `0fc446b4`.

## Historical Baselines

The sealed cohort is retained under
`tmp/simulation-final-cohorts/cohort-8fWEDa/`: `plan.json`, four lane results,
`final-assessment.json`, `audited-classification.json` and
`weighted-fork-analysis.json`. All 26 declared cases executed, with no missing
or unqualified pairs. Every pair passed exact serial replay and complete raw
disk equality. Property results remain separate:

| Lane                           | Executed | Passed | Failed |
| ------------------------------ | -------: | -----: | -----: |
| Named regressions, shard 1     |        7 |      4 |      3 |
| Named regressions, shard 2     |        7 |      4 |      3 |
| Held-validation command orders |        6 |      4 |      2 |
| Header-error command orders    |        6 |      3 |      3 |
| Total                          |       26 |     15 |     11 |

The failures have different meanings:

- Two fresh-proof cases, including actual weighted routing, accept an ownership
  read from the other fork and expose an invalid seller listing through HTTP.
  Both have a real newer source revision, a completed current-generation proof,
  explicit provider healing and no pending validation debt. These are reached
  application consistency counterexamples.
- Startup maintenance removes two completed validation proof rows while both
  canonical orders survive unchanged. This is observed immediately after real
  successful maintenance, with all actors stopped and before restart. It proves
  lost reusable coverage, not lost pending work or incorrect fillability.
- Seven cases reproduce a domain `SIGSEGV` before their intended recovery
  history. Its cause remains unattributed. In source `63221604`, ordinary exits
  inherit the active check label; their retained history gaps prevent crediting
  that label as a reached reorg oracle. Commit `21ef56ad` separately corrects
  typed runtime-exit attribution; `68de8eb2` also preserves runtime property
  identity through oracle wrappers. Original reports remain unchanged.
- The weighted fork observes incompatible stored A105/B106 ancestry after
  actual divergent headers and explicit healing, then times out waiting for
  rollback. Only checks 106/107 remain, ineligible at fixed head 107 with depth
  3, and head publication waits behind that rollback acknowledgement. The
  retained mixed boundary is a finding; permanent failure under fair post-heal
  head progression and full recovery remain unproved. No deadlock is inferred.

The replacement `artgod-weighted-fork-v2` descriptor keeps the split at B106/A105,
witnesses the supported recovery dependency, explicitly heals every endpoint,
then publishes eligibility and starts timestamp-driven head growth before the
rollback wait. Legal earlier A104 recovery is also retained as evidence. The 54
affected split, producer, admission, corpus and CI checks passed at that stage.
Fresh version-2 results are recorded above; the original version-1 recording
remains unchanged.

The passing cases include actual bootstrap pause/retry/restart, the default RPC
budget, lagging providers, broker/offchain restart, unsupported-fork refusal,
the transient stale-result cut and seven complete adversarial command histories.
Only seven of the twelve campaign histories reached their complete assertions;
executing all twelve does not supply the missing history coverage.

A separate native-Node audit of the explicit 15-pass list is retained at
`native-host-audit-meKkSC/receipt.json` inside that cohort. It found no discrepancy:
exact header/ownership/transfer/fill facts were checked for all 15, full settled
market assertions for 14, and 26 active proof identities through their owning
contract. Available A104 sale checkpoints also passed nonempty fill checks.
The oracle/world/proof owner files and lockfile match source `63221604` byte for
byte. This reevaluates retained observations with shared model/oracle algorithms;
it reruns no production actor, database, broker or wire request and does not
recompute raw disk parity. That cohort's proof projections omit `required_at` and
`minimum_block`, so neutral requirements check identity without establishing
unavailable source-time/event-floor freshness. Bootstrap pre-anchor completeness
and refused-recovery winning-branch or terminal-proof convergence are excluded;
this additional execution does not qualify other CPU, RPC-model or runtime paths.

The permanent convergence oracle now projects actual `required_at` and
`minimum_block` requirements and uses the validation-demand owner's coverage
contracts against the current order revision and retained requirements. Missing
evidence fails explicitly; source-terminal exceptions retain their existing
semantics. A completed cached proof may retain an earlier chain revision: this
does not make it reusable after rollback. Current-chain coverage is additionally
required for the stale cut's witnessed new post-rollback bid generation and the
fresh-provider histories. The native comparison exposed the old unconditional
chain-equality assertion; its original failed report is retained. Fresh
final-source runs above supply current evidence; they cannot recover fields
absent from this historical cohort's observations.

Source `793e057b` subsequently passed all 395 supporting tests, a fresh full-build
M0 (`run-4TxxXk`, 218.072 seconds), the corrected context probe (`run-Y3K6YL`,
173.356 seconds), independent core inspection and full/reuse logical equivalence.
The sealed `cohort-YlwrtF` was intentionally stopped after a contract review
identified the committed-counter fixture's unsupported bid-reactivation
expectation. Three cases passed their properties, one reproduced a domain
`SIGSEGV`, four additional cases were interrupted and eighteen were unstarted.
The four completed pairs passed strict serial/disk replay. All statuses and the
explicit interruption reason remain unchanged; this is not a complete final
cohort. The review also found historical weighted retry cancellation before
healing, so the correction must distinguish witnessed retention from a merely
permitted conservative terminal state across ordinary fork histories.

Historical baseline pair times range from 283.769 to 941.765 seconds, with median 340.584
seconds. The slowest lane sums to 3,195.473 seconds of pair execution. Paired run
directories allocate 2,303,414,272 bytes, excluding reusable guest/capsule/case
inputs. These are local shared-host measurements, not hosted CI budgets or peak
memory measurements. The guest is configured with 2 GiB and one vCPU; native
multicore data races are outside this execution profile.

This is a working problem-finding baseline, not yet a replacement for all manual
QA. Its current property failures keep the recorded corpus red. Native runtime
diagnosis, unsupported scenario families, hosted execution, other hosts and
desktop/release qualification remain separate work. No failed application
assertion is waived and no production hardening is included.

## Execution Boundary

The running guest contains the production headless runtime closure, real NATS
and native SQLite, plus the coordinator and fake external services. It has no
host-mounted state or external network device. The VM backend uses fixed
single-vCPU TCG execution, a pinned CPU/machine/epoch, an explicit kernel and
firmware, and replay-aware block devices.

The image builder may use project-scoped bind mounts inside authorized build
containers to compile native SQLite. That build operation is distinct from the
isolated guest execution. Neither phase attaches to application-data stores.

## Prerequisites and Guest Build

Use the repository's pinned Node/Yarn and normal dependency workflow. Required
local tools include Docker, filesystem-image tools and supplied
kernel/firmware/NATS inputs. Do not install host packages from these scripts.
On a Qubes AppVM, missing system dependencies belong in the TemplateVM workflow.
Image pulls were explicitly authorized for this task; scripts require immutable
image references and fail when required inputs are absent.

The checked-in [input profile](../../config/simulation-inputs.json) owns the OCI
pins, `pc-i440fx-8.2` machine and preferred `virtio-bounce-v1` storage profile.
Prepare inputs with explicit installed
tool paths; adjust these example paths to the local tooling layout:

```sh
yarn simulation:inputs --qemu /usr/bin/qemu-system-x86_64 --qemu-img /usr/bin/qemu-img --firmware /usr/share/qemu/qboot.rom --scenario scripts/simulation/scenarios/qualification.json
```

This pulls the pinned images, extracts the kernel and production-version NATS,
and prints a `buildConfigPath` under `tmp/simulation-inputs/inputs-*`. It does not
install host tooling or replace running services. The qboot firmware is required
by the qualified direct-Linux-boot profile. A different firmware needs its own
qualification.

The current [builder](../../scripts/simulation/build-guest.mjs) takes an explicit
local JSON configuration under the active worktree's `tmp/`:

```sh
yarn node scripts/simulation/build-guest.mjs --config tmp/simulation/build-config.json
```

Its version-1 configuration requires these fields, with only the documented
optional tool capsule field accepted:

| Field                                                 | Required input                                                                                                                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtimeImage`, `builderImage`, `busyboxImage`        | Provisioned `image@sha256:...` references; runtime/builder Node must match the repository pin, BusyBox must be static.                                         |
| `kernel`, `firmware`, `natsBinary`, `qemu`, `qemuImg` | Explicit existing paths, relative to the configuration file or absolute in that untracked local file. NATS must match the production pin.                      |
| `scenarioFile`                                        | Explicit JSON scenario, relative to the configuration file or absolute. The shared host/guest contract rejects unsupported journeys, checks and hidden inputs. |
| `machine`                                             | Explicit available versioned i440fx machine; the portable profile is `pc-i440fx-8.2`.                                                                          |
| `cpu`                                                 | Explicit supported TCG CPU model, `Nehalem` or `max`. The selected model and saved engine bytes form one execution input.                                      |
| `storageProfile`                                      | Explicit `virtio-v1`, `ide-pio-v1` or `virtio-bounce-v1`; the controller, kernel root device and read-only scenario device are part of the replay contract.    |
| `epoch`                                               | Exact UTC timestamp such as `2026-11-08T00:00:00Z`.                                                                                                            |
| `version`                                             | `1`.                                                                                                                                                           |
| `toolCapsuleFile`                                     | Optional path to a saved, admitted OCI tool descriptor. QEMU/QEMU-img/firmware byte pins must match it.                                                        |

The builder reuses production runtime build, native-SQLite and dependency-staging
owners, packages a standalone qcow2 image and writes an input manifest and
provenance under `tmp/simulation/guest-*`. It must preserve those artifacts.
Building an image does not qualify execution. Review the emitted payload and
source provenance; a source commit name alone does not account for dirty or
untracked inputs. Compilation checks source membership and file hashes before
and after both runtime and coordinator builds, including untracked sources;
changes during compilation fail the build. The provenance also inventories the
actual staged payload, symlink targets and admitted tool bytes. Finish editing
before building a reusable guest.

## Retain the Emulator Userspace

The [tool capsule owner](../../scripts/simulation/tool-capsule.mjs) builds QEMU
inside the digest-pinned Ubuntu image in the input profile. Package installation
happens inside that Docker build. It saves the actual final image archive,
records its immutable image ID and archive hash, and extracts pinned
QEMU/QEMU-img/firmware bytes for admission. The saved archive retains the image
layers through [Docker's image-save command](https://docs.docker.com/reference/cli/docker/image/save/):

```sh
node scripts/simulation/tool-capsule.mjs build
```

Keep the returned `tmp/simulation-tools/tools-*/` directory. Set the build
configuration's `qemu`, `qemuImg` and `firmware` to its extracted files and
`toolCapsuleFile` to its `tool-capsule.json`. The builder and execution runner
then invoke those tools inside the saved image through the existing owned
container lifecycle. Each tool container has no network, a read-only root and
worktree, and write access only to the current output directory. The emulated
guest still has no host mounts. Container commands clear inherited environment
variables before setting the fixed replay environment.

Select that capsule for a new execution of an already built runtime image with:

```sh
node scripts/simulation/tool-capsule.mjs bind --manifest tmp/simulation/guest-RUN/manifest.json --capsule tmp/simulation-tools/tools-TOOLS/tool-capsule.json
```

Use the returned manifest for a new record/replay pair. Selecting another engine
does not make an old host recording portable. Preflight checks the archive,
loaded image identity, tool byte pins and platform; it never silently pulls,
loads or rebuilds an absent image. Restoring a saved image is explicit:

```sh
node scripts/simulation/tool-capsule.mjs restore tmp/simulation-tools/tools-TOOLS/tool-capsule.json
```

Rebuilding the same Dockerfile can fetch different package versions. Preserve
the original saved image archive rather than expecting a future build to
reconstruct it. The host kernel and container daemon remain external to this
userspace capsule; replay on a different host still needs qualification.

## Reuse the Runtime Image for Another Case

The selected case is a separate pinned 8 MiB raw ext4 disk, mounted read-only as
`/scenario`. With `virtio-v1` or `virtio-bounce-v1` its device is `/dev/vdb` and the runtime root is
`/dev/vda`; with `ide-pio-v1` the runtime root is `/dev/sda` and the scenario is
`/dev/vda`. The runtime image does
not contain a default case. A missing scenario disk fails guest startup rather
than silently selecting a smaller workload.

The [case preparer](../../scripts/simulation/prepare-case.mjs) validates a new
scenario, creates its immutable payload and writes a fresh manifest reusing the
admitted runtime/kernel/firmware/engine pins:

```sh
node scripts/simulation/prepare-case.mjs --base-manifest tmp/simulation/guest-RUN/manifest.json --scenario scripts/simulation/scenarios/fork.json
```

Use the returned manifest path for preflight and execution. Case preparation
does not boot a VM or rebuild runtime artifacts. The scenario disk uses explicit
raw format through a read-only replay-aware device, so it cannot introduce
backing-image links. Changing runtime or coordinator code requires rebuilding
the guest; replacing only scenario data is insufficient for those changes.

## Rebuild Only the Coordinator

When only simulation JavaScript modules change, the
[same builder owner](../../scripts/simulation/build-guest.mjs) can reuse a
pristine admitted runtime image:

```sh
yarn node scripts/simulation/build-guest.mjs --rebuild-coordinator --base-manifest tmp/simulation/guest-RUN/manifest.json --debugfs /path/to/debugfs --e2fsck /path/to/e2fsck
```

Supply explicit installed tool paths. This refuses production, configuration,
dependency, production build-script or guest-init source changes. It reconstructs the old
coordinator from its admitted source commit and requires the current compiler
and dependency bytes to reproduce that bundle exactly. Existing dependency pins
must stay exact. A newly imported repository contract must already match the
admitted source inventory; new external/cache dependencies require a full build.
There is no fallback.

The full builder also records the generated kernel-helper asset outside the
workbench payload. Reuse requires that pin to match the current rendered helper
and verifies its regular-file type, mode and bytes in both image readbacks.
An older base without that asset, or a changed dispatcher, requires a full
build. Historical recordings remain replayable with their own pinned inputs.

The update copies the pristine guest into a fresh raw image, replaces only the
fixed coordinator file, verifies its readback and inherited init, runs read-only
filesystem checks, then converts a new standalone qcow2 image. It preserves
the original image and records its runtime origin separately from current
coordinator source/dependency pins. No valid manifest is published until all
image, source and origin checks pass. All intermediate diagnostics remain
retained on failure. This reduces retained staging copies; it does not qualify
execution. Run the expanded M0 gate and affected scenarios on the returned
manifest.

## Preflight, Record and Replay

The [QEMU runner](../../scripts/simulation/qemu-replay.mjs) does not discover or
download inputs. First validate the builder's actual manifest path:

```sh
node scripts/simulation/qemu-replay.mjs --manifest tmp/simulation/guest-RUN/manifest.json
```

The read-only preflight requires a strict version-1 schema, SHA-256/size and
exact version-output pins for QEMU/QEMU-img, pinned kernel/firmware/guest/scenario bytes,
the declared source SHA, explicit machine/epoch/timeout and named guest checks.
It verifies the machine is available and the guest is standalone qcow2 without
backing files, external data, encryption or known corrupt/dirty flags. Unknown
manifest options fail rather than introducing arbitrary emulator arguments.

Run the admitted guest explicitly:

```sh
node scripts/simulation/qemu-replay.mjs --manifest tmp/simulation/guest-RUN/manifest.json --run
```

This creates fresh separate record/replay overlays under
`tmp/simulation-qemu/run-*`, keeping the supplied guest image unchanged. It
starts real QEMU with the selected profile's fixed kernel arguments. The
preferred `virtio-bounce-v1` profile uses:

```text
root=/dev/vda rw console=ttyS0 earlycon=uart8250,io,0x3f8,115200n8 init=/workbench/init panic=1 iommu=soft swiotlb=force ARTGOD_SCENARIO_DEVICE=/dev/vdb
```

The profiles use qboot, one explicitly pinned vCPU model, TCG, 2 GiB RAM and
`icount shift=0,align=off,sleep=on`. Virtio devices use `ioeventfd=off`.
These are execution inputs, not performance knobs to change during replay. The
host watchdog permits slow emulation; guest application deadlines still use the
production clock and policies.

New manifests declare `cpu`; old frozen manifests without it retain their exact
`Nehalem` arguments. The preferred `max` profile uses the
[software-supported TCG feature set](https://github.com/qemu/qemu/blob/v8.2.2/target/i386/cpu.c#L5531-L5579)
and saved engine. Selecting it requires fresh qualification; it cannot change an
existing recording's CPU model.

New builds require an explicit storage profile and pass
`ARTGOD_SCENARIO_DEVICE` through the kernel to PID 1; the guest rejects a missing
or unknown device. The `ide-pio-v1` control uses an IDE root disk with
`libata.dma=0`; its scenario disk remains read-only virtio. A single control pair
passed all M0 checks and raw disk parity at `run-KP5gv6`, but took 1,181 seconds
(record 512, replay 657). That cost makes it unsuitable as the preferred CI
profile. The kernel accepted DMA-disabled configuration; a maximum-UDMA
capability message alone does not prove the active transfer mode.

The preferred `virtio-bounce-v1` profile sets `iommu_platform=on,disable-legacy=on` on the
writable root controller and boots with `iommu=soft swiotlb=force`. QEMU 8.2
requires modern-only virtio for this feature. In the pinned Linux 6.6.71
source, negotiated ACCESS_PLATFORM selects the DMA API and forced SWIOTLB
mapping copies payload bytes before submission. This addresses the observed
mutable-buffer capture hypothesis without changing ArtGod behavior. Guest
probes require the root device's negotiated feature bit and actual positive
SWIOTLB use counters. With the modern-only correction,
three independent M0 pairs passed all six checks, exact serial bytes and full
raw disk parity at `run-7zthVH`, `run-bTH3ss` and `run-IAgGFJ` (175.8, 190.7 and
165.9 seconds). The joined production baseline also passed all five properties,
exact serial bytes and raw disk parity at `run-mYE4p0` in 289.0 seconds. These
four local pairs support promoting the checked-in profile; they do not qualify
every scenario, a different host kernel or hosted CI.

Old frozen manifests without a profile retain their exact earlier arguments so
their recordings remain replayable with the matching guest. Existing named
profiles likewise keep their recorded argument contracts.

Both modes use the same declared inputs and recorded event log. The runner
rehashes inputs around execution, enforces time/output bounds, and terminates
its process group on deadline or interruption. It retains commands, serial
output, emulator diagnostics, input manifest, event log and a final report.
Never remove the worktree's `tmp/` artifacts unless the user asks.

## Completion and Evidence

The [protocol owner](../../scripts/simulation/qualification-protocol.mjs) defines
the host/guest vocabulary. The guest emits a ready message followed by one
completion message, with the manifest's identity and explicit named check
results. Missing, duplicate, reordered, mismatched or incoherent protocol
messages fail the run. A complete message with explicit failed product checks
is valid evidence and still receives replay. Extra evidence belongs in separate
diagnostics.

Passing the replay gate requires both successful emulator executions, nonempty
serial and replay logs, valid complete guest messages and exact raw serial-byte
parity. New pairs also compare the closed disks' guest-visible bytes through
`qemu-img compare`, independently of qcow2 allocation metadata. The report's
`guestDiskParityStatus` must pass and the closed record overlay is byte-pinned.
Exit zero alone cannot pass. The report separates `engineReplayStatus`
from `propertyStatus`: a reproduced failed scenario keeps a passing replay result
and a failed overall result, and the CLI exits nonzero. M0's separate
`substrateQualificationStatus` requires all eight owned qualification checks to
pass. Guest-reported checks still require implementation review.

`propertyStatus: failed` records a failed scenario assertion or required step;
it does not by itself establish an ArtGod defect. A stalled prelude retains
missing-history evidence and leaves the corresponding oracle unreached. Such a
run cannot be minimized as a reached oracle counterexample. Review the actual
history, capability errors and reached checks before classifying a finding.

The current qualification workload targets native SQLite/WAL/concurrent writers
and NATS persistence/redelivery with guest entropy/clock observations. It does
not substitute for production sync/reorg/orderbook scenarios. A replay log
reproduces one recorded execution; it does not enumerate alternate schedules or
prove the scenario passes after source changes.

Without a tool capsule, the host's QEMU shared libraries and kernel are not fully
pinned by the input manifest. The OCI route retains QEMU userspace; it does not
pin the host kernel. Preserve the recorded environment and qualify replay on any
new environment before claiming portability. Desktop/native release and hosted
CI evidence remain independent.

Local M0 evidence is retained in `tmp/simulation-qemu/run-1agK1X/report.json`:
machine `pc-i440fx-8.2`, all six substrate checks passed, passing engine replay
and exact serial parity. This proves the exercised SQLite/NATS substrate, not
the production pipeline. The earlier `run-jrzexX` reproduced a workload timeout
with passing engine replay and failed properties; failed workloads are not
waived by reproducibility.

The joined production baseline passed at
`tmp/simulation-qemu/run-ULq4jl/report.json`, using frozen guest `guest-7m5DHk`:
ten actual runtime entrypoints, chain acquisition, REST/stream admission, full
order validation and HTTP projection, followed by finite-producer obligation
drain. All five named checks passed and replay matched the 47,786 serial bytes.
The local pair took 268.1 seconds: record 87.9 seconds and replay 175.3 seconds,
with a 66.8 MB event log and 2 GiB configured guest RAM. This measurement does
not establish fork recovery, alternative schedules, peak host memory or CI time.

The saved Ubuntu QEMU 8.2.2 capsule also completed M0 at
`tmp/simulation-qemu/run-T66FwY/report.json` and the production baseline at
`tmp/simulation-qemu/run-JatEzS/report.json`. Their serial bytes matched exactly;
the baseline's five properties passed. These local pairs took 179.6 and 281.3
seconds respectively on the shared host. A later M0 pair,
`tmp/simulation-qemu/run-ypU575/report.json`, passed the mandatory closed-disk
gate and pinned its record overlay; the earlier M1 disks also compared equal
through the saved tool image. The later M0 pair took 193.5 seconds. This is
execution under the retained userspace, not hosted CI or general cross-host
qualification.

A later virtio M0 pair, `run-aaRfqu`, passed its six printed guest checks and
matched serial bytes but failed the disk gate. An exhaustive comparison of both
2 GiB raw disks found exactly three changed bytes in a block marked free by
both allocation bitmaps. The block matches SQLite's WAL-index hash layout;
all nine current SQLite/NATS/config files and all other disk bytes matched.
The images and forensic summary remain under
`tmp/simulation-disk-diagnostics/m0-A13lFp/`. This is an engine qualification
failure, not evidence of an ArtGod defect or an established upstream cause.
The PIO control and three forced-bounce M0 pairs passed while retaining the
strict gate; forced-bounce also passed the production baseline. The asynchronous buffer-capture
mechanism is an inference supported by the pinned kernel/QEMU source and the
control results; this does not establish an upstream defect. The workbench does
not zero free space or silently treat unequal disks as equal.

The M4 startup-maintenance run `run-TgrQzS` reproduced a different, application
retention finding with passing engine replay and raw disk parity. Two completed
`order_validation_demand` proof rows existed initially; none remained after
maintenance and restart, although the listing remained source-active and
fillable, and no validation demand or outbox work remained pending. The final
generic oracle failed `current-sell-validation`. This demonstrates lost saved
validation coverage, not incorrect fillability or canonical chain state.

The [orders contract](../indexer/07-domain-orders.md#processing-ownership-and-retained-state)
requires completed coverage to remain reusable while its order exists. The
[demand adapter](../../indexer/src/infra/orders/sqlite-order-validation-demand.ts)
requires the saved row for coverage; `validated_at` alone does not replace it.
The [maintenance implementation](../../indexer/src/infra/storage/sqlite-market-data-maintenance.ts)
swaps the orders table with `DROP TABLE`/rename while the
[demand foreign key](../../database/migrations/058_order_validation_demand.sql)
cascades on order deletion. Losing coverage can therefore cause redundant
free-RPC validation, although that additional traffic was not measured in this
run. Loss of genuinely pending demand is a separate risk that this completed
fixture does not establish. The existing failed oracle remains; no production
fix or weaker assertion is included.

The [lifecycle driver](../../scripts/simulation/guest/lifecycle.mjs) now captures
nonempty completed coverage with all production actors stopped and asserts
`completed-validation-coverage-retained` immediately after actual maintenance,
before restarting actors. It retains both snapshots and requires unchanged
proof rows for surviving canonical orders. Deleting an owning order may delete
its proof; an empty fixture cannot earn this property. The old run predates
this more precise boundary assertion. Fresh runs `run-QPatdk` and `run-ne43ve`
both reached it and reproduced the coverage loss with strict serial/disk replay.

The initial 25-case cohort at source `15ce0ecb` was intentionally stopped with
its missing cases retained. Qualified failed run `run-eFT7fD` reached actual
rollback/resync and canonical HTTP state, with fresh provider tips, empty
business obligations and no retained broker messages. Acquisition remained one
block behind a continuously advancing synthetic head. Requiring full live-tip
catchup before stopping that producer could starve a legal eventual-consistency
consumer. The corrected fixture freezes publication when business work drains,
then retains the complete coverage, header, mature-check and final property
assertions on that fixed cut within the same deadline. This is a harness
correction; the old failure is not assigned to ArtGod, and original reports are
unchanged. The corrected 26-case cohort is now fully accounted for in
[Historical Baselines](#historical-baselines); its own remaining failures
retain their separate causes and coverage gaps.

The targeted stale-result trial `run-gvHMAC`, at source `1169f39c`, reproduced
the domain worker exiting with `SIGSEGV` before any A105 counter request reached
the external service. Engine replay, all 115,777 serial bytes and the complete
final disk matched. The stale-result cut was unreached; this is no evidence of
successful stale-result rejection or an incorrect stale publication. The
retained process state establishes the native process failure, but neither
logs nor serial output establish whether its cause belongs to ArtGod, Node, a
native dependency or emulation. No production fix is inferred from that run.
New guests additionally retain bounded, read-only kernel-ring, core-policy and
coordinator-resource-limit observations in `native-failure.json` on failure.
Missing access, timeouts and output truncation remain explicit diagnostic
results. These default observations do not enable core dumps or change kernel
policy; the opt-in guest-only capture profile is described below.
The targeted cut also requires a single bidder-counter request through its
rejection observation. A transport retry makes consumption of the captured old
result unproved, even if a later snapshot check fails; it cannot earn that
specific safety coverage.

The later basic-qualification run `run-tUrifi` failed before readiness during
fixture crypto initialization with a BigInt type error. The same admitted bundle
initialized successfully on native Node and inside the pinned runtime
container. A record-only control, `tmp/simulation-controls/cpu-max-z03oun`, changed
only `-cpu Nehalem` to `-cpu max` on the same saved QEMU 8.2.2 and guest. It passed
initialization and the original six qualification checks. That control has no
replay or disk-parity qualification and identifies no specific upstream defect.
It is evidence against assigning the initialization error to ArtGod behavior.
The separate strict CPU-`max` pair `run-HhmBiP` then passed all six original
checks, exact 30,058-byte serial parity and complete disk parity in 182.268
seconds. Its `substrateQualificationStatus` remains `not-run` because it lacks
the expanded checks. This qualifies that pair's replay, not the new M0 gate or
the cause of the earlier CPU-sensitive failure.

The generic failure formatter is again protocol-only; data-plane attribution
does not eagerly load fixture cryptography into basic failure reporting. New
qualification inputs additionally require hot BigInt/native-conversion and
crypto known-answer checks, run after readiness so failures retain evidence.
Earlier six-check M0 results do not satisfy this expanded eight-check gate.
Three independent expanded-gate pairs at source `41504870`, `run-A3kOIL`,
`run-oVFdwd` and `run-fpX7PX`, passed all eight checks, exact 31,297-byte serial
parity and complete disk parity on CPU `max`. They took 172.834, 195.262 and
182.306 seconds. Each compared 24,576 arithmetic, 8,192 native SQLite integer
and 102 fixture crypto results to independent known answers. These runs qualify
the exercised runtime profile; they identify no upstream cause for the earlier
failure and do not prove every engine/compiler path.

The first CPU-`max` stale-cut trial, `run-OXplyC`, also passed serial and complete
disk replay but left its safety oracle unreached. Its old A105 counter started
around guest second 45.6; rollback committed at 48.0, the RPC timed out at 55.7,
and full resync finished around 59.7. Waiting for full recovery before releasing
that exact ten-second transport was an invalid fixture precondition. The
corrected cut observes committed rollback with active resync, requires the
unique persisted finish-refusal reason before the earliest request timeout,
and retains complete resync/HTTP convergence afterward. It does not change
application deadlines. Fresh runs `run-08BUfD` and cohort case `run-uvGGmS`
passed all seven checks with exact serial and complete disk parity. They earn
snapshot-finish refusal with an additional source-revision fence present, not
isolated database-checkpoint-fence coverage.

## Guest Native Crash Diagnostics

The [native evidence owner](../../scripts/simulation/guest/native-failure-evidence.mjs)
provides an explicit `bounded-core-v1` profile for a fork diagnostic variant.
Normal cases keep their original Node executable/arguments and inherited core
limit. The profile enables only domain generation zero, with an exact 32 MiB
hard/soft limit through the already admitted guest `prlimit`. It sets a fixed
private-guest core path and filter `0x10`, excluding heap/stack mappings, then
records the effective actor limits, filter, executable and unchanged argv.
There are no JavaScript signal handlers or host sysctl/prlimit changes.

At capture-image source `6d0b6308`, all 315 supporting workbench tests passed
without skips. A later reporting-only correction at `68de8eb2` normalizes typed
runtime property identity through oracle wrappers; all 318 supporting tests
passed without skips. That correction is absent from the frozen capture guest;
its retained inputs and byte pins stay unchanged. Guest `guest-coordinator-14tsty`
and the M0/probe/trials below use source `6d0b6308`. It passed normal eight-check
M0 at `run-4Bq9CJ`, including
strict serial and disk comparison, in 182.118 seconds. This is separate from the
26-case cohort at source `63221604` and does not erase its original failures.

The [capture probe owner](../../scripts/simulation/guest/native-core-probe.mjs)
exports an explicit descriptor outside the regression corpus. Materialize it
under a fresh worktree temporary directory:

```sh
yarn node --input-type=module <<'NODE'
import { createArtifactRunDirectory } from "./scripts/simulation/artifacts.mjs";
import { NATIVE_CORE_PROBE_SCENARIO } from "./scripts/simulation/guest/native-core-probe.mjs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
const directory = await createArtifactRunDirectory("tmp/simulation-native-diagnostic-inputs", "probe-");
const filename = path.join(directory, "scenario.json");
await writeFile(filename, `${JSON.stringify(NATIVE_CORE_PROBE_SCENARIO, null, 2)}\n`, { flag: "wx" });
console.log(filename);
NODE
```

Run that actual descriptor with `yarn simulation run --base-manifest ... --scenario ...`
after normal M0 passes. The probe writes and pins a reviewed 126-byte static
x86-64 ELF **inside the guest only**. Its zero-address store must produce
SIGSEGV/MAPERR, address zero, RIP `0x40007a`, and the exact fixture file mapping
and offset. It rechecks fixture bytes after exit. Never execute that artifact
on the host. Probe success additionally requires complete signal/register/file
notes, effective policy receipts, strict replay and full disk parity; a core
file or child signal alone cannot pass. Its check does not replace or expand
the eight mandatory M0 checks.

Use the existing read-only extraction command on the completed run to retain
raw cores, then match each size/SHA-256 to `output/native-core.json` before and
after independent installed `readelf -h -l -n` and `eu-readelf -n` inspection.
Their supported decoded signal/register/mapping fields must agree with the
receipt. Parser-only Buffer tests are not evidence that actual capture works.

The actual probe `run-J41GMt` passed its property, exact serial and full disk
comparison in 151.273 seconds. Its 36,864-byte raw core was extracted under
`extract-7myyAx`; independent GNU/elfutils inspection at
`tmp/simulation-native-diagnostic-inspections/probe-gH9bS8/inspection.json`
agreed on SIGSEGV/MAPERR, address zero, TID 110, RIP `0x40007a`, and the fixture
mapping/file offset `0x7a`. Core and fixture byte pins remained unchanged.
This qualifies the selected capture path locally, not the cause of an ArtGod
runtime crash or another machine.

The subsequent three-trial fork diagnostic series is retained separately at
`tmp/simulation-native-diagnostic-inputs/final-trials-assessment.json`.
`run-e37SS6` reproduced a sync-worker `SIGSEGV` before recovery;
`run-4n5InS` and `run-DC2tyh` passed all six ordinary fork checks. All three
passed exact serial and full disk replay. The selected domain actor stayed alive
in each, so this domain-only profile expected and captured no runtime core.
The synthetic fault qualifies capture; it does not locate the cause of either
the original domain crashes or the additional sync crash. No engine, CPU, Node
flag or application-policy change was made, and the later passes clear no
retained failure. These three runs are additional diagnostics, not part of the
26-case cohort or its 15-pass native audit.

The separate opt-in `registered-core-context-v2` profile covers generation-zero
Node actors from the runtime manifest, including sync and collection bootstrap.
It retains only the first claimed fatal dump; NATS, one-shot maintenance and
restarted generations are explicitly excluded. Normal runtime arguments and
the version-1 profile remain intact.

The first context probe at source `d47a59b9`, `run-O7nDkX`, reproduced its failed
capture property with exact serial and complete disk equality. The admitted
LinuxKit kernel enables `CONFIG_STATIC_USERMODEHELPER` at
`/sbin/usermode-helper`, absent from that image; kernel helper execution failed
before the Node collector started. The fixture signal alone supplied no core
qualification. The full builder now stages a fixed dispatcher that permits
only the exact collector argument shape and private BusyBox-init guest before
executing the fixed Node path. V2 admission checks its actual executable bytes
before changing guest core policy. Fresh M0 and capture-probe execution are
required after this image change; no host helper or policy is modified.

The corrected full image `guest-BprF6N` at source `30f974ea` passed all eight M0
checks and strict serial/disk equality in `run-oZfNgt` (208.173 seconds). Its
context probe `run-Sckyng` passed capture and those same replay gates in 182.364
seconds. Read-only extraction `extract-uTckQR` and independent inspection at
`tmp/simulation-native-context-inspections/probe-vJvvpG/inspection.json` confirm
the raw signal/register/file notes, authored stack return and marker, actual
instruction bytes and derived ranges. All nine inspected artifact pins remained
unchanged. This qualifies that capture path; it does not attribute an application
fault.

Its fixed guest-only pipe collector bounds raw input to 32 MiB, maps to 256 KiB,
stack memory to 64 KiB and instruction memory to 512 bytes. It retains the
kernel-assigned core-limit sentinel of one to prevent recursive helper dumps.
For the pinned kernel, an open pipe reader retains the dying task's memory;
the helper owns fd0 until its bounded memory reads and receipts finish. Its
10-second JavaScript deadline is cooperative; the outer VM watchdog remains
the backstop for synchronous/native hangs. Timeout evidence cannot replace an
earlier claimed core receipt.

The raw core, maps and memory sidecars have separate byte pins. `analysis.core`
is explicitly derived from the raw notes and those windows, with source ranges
and hashes. Match actual guest executable/library bytes for analysis; do not
silently resolve guest mappings against host libraries. Missing windows, extra
faults outside the one-capture budget and incomplete unwinding remain gaps.
Use the exported `NATIVE_CORE_CONTEXT_PROBE_SCENARIO` in the materialization
recipe above for this profile. In addition to the known zero-address store,
its saved stack must contain the authored return address and marker. Inspect
raw notes and sidecars independently before using a real runtime capture to
choose an informed comparison. No synthetic fault fixture runs on the host.

The [bounded parser](../../scripts/simulation/guest/elf-core-notes.mjs) consumes
only the pinned Linux x86-64 format. It preserves raw siginfo, decodes known
unions, and uses the pinned kernel's first-PRSTATUS fault-thread ordering rather
than selecting the leader PID. Missing/truncated/unsupported evidence remains
explicit; raw cores survive parser failure. By itself, filter `0x10` provides
no heap/stack/JIT-byte capture or promised unwindable stack. A mapped RIP locates
a code region and does not establish whether the cause belongs to ArtGod, a
native dependency, V8, the kernel or emulation.

The selected real header-error diagnostic `run-hWnwIL` then captured a domain
worker `SIGSEGV`, with exact serial and complete disk replay in 342.694 seconds.
The 118,784-byte raw core and complete bounded windows identify the observed
site as V8 `IC::UpdateState`, reading through an object pointer outside all
captured mappings. Independent disassembly matches the actual Node bytes;
bounded saved frame slots continue through load-IC, JIT and asynchronous
callbacks. The final self-sent signal is compatible with Node's trap re-raise
path and is not treated as the original fault address. The root cause remains
unresolved, and recovery assertions were not reached. Raw/guest ELF pins and
analysis are retained under `tmp/simulation-native-context-inspections/` and
`tmp/simulation-native-inspection/`.

That real core exposed a derived-ELF layout incompatibility with elfutils.
Preserving page-congruent LOAD offsets corrects module reconstruction without
changing raw notes, captured bytes or virtual ranges. Original artifacts remain
unchanged. Limited captured memory still prevents a complete DWARF/JavaScript
unwind; a derived file is never substituted for raw evidence.

## Native Execution Control

The [native control owner](../../scripts/simulation/native-control.mjs) provides
an explicit Linux/amd64 diagnostic comparison. It runs the retained full-build
coordinator, production entrypoints, SQLite, NATS and fake external services
inside an isolated container with unchanged Node arguments. It records target
and observer sources separately and admits only simulation-tool source changes
around the frozen target. Staged bytes, symlinks, scenario bytes and the actual
container Node must match the admitted full build.

Use temporary copies of ordinary descriptors and an explicitly allowed host
CPU. For example, after preparing the input directory:

```sh
yarn node scripts/simulation/native-control.mjs --manifest tmp/simulation/guest-FULL/manifest.json --scenario tmp/native-inputs/qualification.json --cpu 0
```

The typed profile fixes one CPU, 2 GiB, no extra swap, finite PIDs, nonroot
identity, read-only inputs, private namespaces and loopback-only networking.
Pre-Node admission verifies actual cgroup/proc settings, zero capabilities and
an inherited hard/soft core limit of one. This suppresses the Linux pipe-core
handler without changing host policy. Existing private-namespace low-port access
must already support the unchanged HTTPS endpoint. Guest-only core descriptors
are rejected; no synthetic fault executes on the host.

Run the native M0 workload before a selected plain system history. Use identical
authored descriptor bytes for the matching VM/native comparison and retain
their realized clock/order-hash differences. Native CPU, kernel, scheduling and
storage change together, so a non-reproduction cannot clear the recorded crash
or identify emulation as its cause.

The first native M0, `control-RWy0yc`, passed all eight checks in 6.427 seconds,
including effective-container admission and unchanged input pins. The same plain
header-error ERVS descriptor then ran natively as `control-ma5yx3` and in the VM
as `run-cGh8Y1`, using full target source `30f974ea` and observer `7b5d1b65`.
Neither crashed. The VM passed its properties and strict serial/full-disk replay
in 481.876 seconds. Native execution and integrity passed in 55.508 seconds,
but its original property report failed the older unconditional chain-proof
assertion. The bid retained chain-revision-0 coverage after revision 1, without
a fixture-witnessed new post-rollback requirement. The contract permits that cache;
its presence does not prove reuse or a stale commit. The oracle correction keeps
this report intact and scopes current-chain checks to witnessed fresh work.
Different realized clocks, order hashes and schedules limit this comparison;
it neither reproduces nor explains the independently captured V8 fault.

Reports under `tmp/simulation-native-controls/control-*` contain native-only
execution, property and integrity verdicts. Cleanup must be acknowledged before
mutable evidence is read; stdout terminal evidence and written results must
agree. Failed properties remain failed. These controls publish no replay or
full-disk qualification and do not replace the simulation corpus.

## Workbench Commands and Campaigns

Run a named JSON case against an existing production guest, or the current fixed
regressions, through the owning runner:

```sh
yarn simulation run --base-manifest tmp/simulation/guest-RUN/manifest.json --scenario scripts/simulation/scenarios/fork.json
yarn simulation regressions --base-manifest tmp/simulation/guest-RUN/manifest.json
yarn simulation models
yarn simulation plan --orders causal --faults all
yarn simulation campaign --base-manifest tmp/simulation/guest-RUN/manifest.json --orders causal --faults all
```

The causal profile declares `E` before `V` and `R` before `S`, giving six command
orders per authored fault model. `--orders all` enumerates all 24 permutations
of those four commands per model. Read `models` for the exact event definitions
and limits. In particular, releasing the external response gate does not prove
the validator finished before the next command. These are external command
orders, not all worker, network delivery, transaction or kernel schedules.

Every authored data-plane JSON case in `scripts/simulation/scenarios/` belongs
to the fixed regression corpus. Discovery validates every case and rejects
duplicate identities; adding a case needs no second registration list. The
qualification workload remains the separate M0 gate.

Before starting the first regression VM, the runner captures and pins every
selected scenario descriptor. It retains the original source path as
provenance, validates the captured bytes again before each launch and keeps
those `scenario-*.json` files with the plan, cases and reports. Later source
edits cannot silently replace a case partway through the suite.

Campaigns retain a plan, rendered scenarios, incremental executions and a
coverage report under `tmp/simulation-campaigns/campaign-*`. A debug `--limit N`
leaves the remaining specified cases missing and cannot pass the campaign.
Failed scenarios do not stop later cases; operator interruption does. Required faults, prelude barriers,
action order and final checkpoints need observed evidence; omitted or unreached
effects cannot count as covered. Emulator failure, failed property and missing
evidence remain separate outcomes. Fixed regression reports live under
`tmp/simulation-regressions/regressions-*`.

An interrupted child retains a structured interruption code and its available
run evidence. Abrupt termination between child executions can leave a partial
run; remaining cases stay missing, not product failures. Neither form of
interruption counts as a completed campaign.

New machine-pair reports record host elapsed time per record/replay phase, serial
and event-log sizes, and configured guest memory. These measurements guide CI
budgets; they do not change guest time or assert host-wide peak resource use.

Inspect retained evidence or reproduce an existing completed execution:

```sh
yarn simulation inspect --run tmp/simulation-qemu/run-RUN
yarn simulation replay --run tmp/simulation-qemu/run-RUN
yarn simulation extract --run tmp/simulation-qemu/run-RUN --debugfs /usr/bin/debugfs
```

Replay uses the existing event log and a fresh overlay; it never records a new
replacement execution. It checks the original serial/log hashes, pinned inputs
and exact safe emulator profile. Changed runner arguments fail with an explicit
request to restore the matching runner. Keep the guest/scenario images and
recorded environment with a counterexample; a log alone is insufficient.

Export a completed original OCI record/replay pair, including every immutable
input, saved tool image and pinned closed record overlay when present:

```sh
yarn simulation export --run tmp/simulation-qemu/run-RUN
```

Exports normally make independent copies. To retain one local bundle without
duplicating its admitted immutable files on the same filesystem, select:

```sh
yarn simulation export --run tmp/simulation-qemu/run-RUN --storage hardlink
```

This explicit mode shares regular-file inodes and preserves all byte pins;
linked inputs must remain immutable. It fails if linking is unavailable, with
no copy fallback. The reported size is the logical closure size, not additional
physical allocation. Relocated replay still copies its writable reference
before rebasing. CI keeps independent copies, and hardlink storage does not
qualify another host.

Copy the resulting `tmp/simulation-bundles/bundle-*/` directory under the new
worktree's `tmp/`, explicitly restore its saved image, and replay:

```sh
node scripts/simulation/tool-capsule.mjs restore tmp/simulation-bundles/bundle-BUNDLE/tool-capsule.json
yarn simulation replay --run tmp/simulation-bundles/bundle-BUNDLE/run --relocation tmp/simulation-bundles/bundle-BUNDLE/relocation.json
```

Export preserves the original report, manifest, command, serial, event log and
record-overlay bytes. Replay first checks the original safe profile, then
relocates only known input roles and capsule file paths. Image identity, tool
versions, input hashes, machine settings and environment remain fixed. Changed
images, unknown roles or arbitrary arguments fail. A copied reference overlay
can have only its backing path rebased to the identical admitted guest bytes;
the original overlay stays unchanged. Its final guest-visible bytes must match
the repeated replay. Legacy sources without a pinned record overlay keep an
explicitly unqualified repeated-disk result.

The local failed-run exporter defaults to at most three complete bundles; CI
overrides this with one per lane, as described below. Its index records
exported, limited and unqualified cases with reasons; an omitted case is not
described as portable. Original reports, logs and required raw images remain
separate artifacts, including engine failures.

A local relocated replay of the pinned M0 bundle also passed serial and raw
disk parity at `tmp/simulation-replays/replay-lwKAq3/report.json`. That exercised
new input paths and a copied reference overlay using the saved userspace on the
same host kernel; it does not establish arbitrary-host portability.

A genuine failed provider case from the complete cohort, `run-zylfy6`, was
exported as local hardlink bundle `bundle-KAtV1c` (519,403,443 logical bytes).
After explicit saved-image restore/admission, relocated original-log replay
`replay-XhLY1t` reproduced its failed property with exact serial and complete
raw-disk parity. The CLI correctly remained nonzero. This qualifies that
counterexample's same-host path relocation, not independent backup storage or
another host kernel. Original inputs and the pinned record overlay remain
unchanged.

The same genuine failed case was subsequently exported using ordinary copies as
`bundle-62llIX`, with 519,403,443 logical bytes. All 15 checked original/copy
members have identical bytes and distinct regular-file inodes. After explicit
restore of the copied saved image, relocated original-log `replay-2suBxB` passed
engine, exact serial and complete disk equality while reproducing the failed
HTTP/provider property. Before/after receipts in
`tmp/simulation-qualification-closure/storage-review/` confirm unchanged original
and copied bytes and inode identities. This qualifies independent file copies
and same-host relocation; it does not establish a separate backup device or
another-host replay.

The [QEMU image utility documentation](https://www.qemu.org/docs/master/tools/qemu-img.html)
describes comparison and backing-file rebase semantics. The workbench uses the
path-only rebase solely on a copied overlay whose old and new base hashes agree;
it never repairs or rewrites retained original evidence.

Extraction uses the explicit installed `debugfs` path and a new converted image,
with no host filesystem mount. It admits only a completed overlay backed by the
expected pinned guest, retains diagnostics under `tmp/simulation-extractions/`,
and rechecks that source images and manifest bytes stayed unchanged. These are
diagnostic copies; extracting state does not add a passing property assertion.

Optional fault minimization preserves all four core actions and their causal
dependencies. It accepts deletion only when the same explicitly reached failed
check reproduces with qualified replay, under a finite evaluation budget:

```sh
yarn simulation minimize --base-manifest tmp/simulation/guest-RUN/manifest.json --campaign tmp/simulation-campaigns/campaign-RUN --case CASE_ID --budget 16
```

## Continuous Integration

The [CI workflow](../../.github/workflows/system-simulation.yml) uses the
[lane owner](../../scripts/simulation/ci.mjs) to discover and declare its full
job matrix before dependency installation. Every pull request and push to
`main` runs two disjoint shards of the entire named regression corpus, currently
14 cases split 7/7. Scheduled runs and manual dispatches with `campaign: true`
add one independent lane for every authored fault model, each containing all
six causal orders. The current expanded matrix has four lanes and 26 declared
scenario cases. Case and model ownership remains in the corpus and campaign
modules; the workflow contains no second case list.

The plan job passes portable JSON through a job output, following GitHub's
[dynamic matrix pattern](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations#using-an-output-to-define-two-matrices).
`fail-fast: false` preserves other lanes after a failure, while
[`max-parallel: 2`](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations#defining-the-maximum-number-of-concurrent-jobs)
limits concurrent lane jobs. Each lane has its own 180-minute deadline,
dependency/native build, saved emulator closure, production guest build and
actual M0 qualification before its declared cases run. This replaces one
serial whole-corpus-plus-campaign job; it does not waive any case or prove that
the hosted time budget is sufficient.

Each lane validates the supplied global matrix and its exact case list against
fresh owner plans before execution. It retains `lane.json`, `matrix.json` and
the delegated result under `tmp/simulation-ci-lanes/lane-*`. If guest build or
M0 fails, the `blocked` command requires an explicit blocker and records every
assigned case as missing/unreached, with zero executed and an
unqualified/incomplete result. It requires no guest manifest and cannot pass.
The plan job uploads the global matrix independently, retaining the declaration
needed to identify absent or interrupted lane artifacts. A lane that lacks
executed evidence is not covered.

Artifacts use the lane ID to keep their scopes distinct. Each lane exports at
most one complete counterexample bundle. A measured bundle was 510,134,028
bytes. Four scheduled lanes therefore retain at most four complete copies,
approximately 2 GiB at that measured size. This bounds the number of extra
copies, not total artifact size. All
original failure inputs, guest/overlay images, saved emulator inputs, raw
logs, scenario descriptors and reports remain separately retained, including
unqualified engine failures; the export index explains cases without a complete
bundle. Reports and replay traces have seven-day retention, while failed guest
images and complete bundles have three-day retention.

Workflow configuration and local results do not establish hosted CI success,
arbitrary-host replay portability or release qualification. Hosted execution of
this matrix remains unverified.

## Focused Tooling Checks

The runner tests exercise strict inputs, isolated argument construction, changed
pins, protocol/parity failures, nonzero exits and deadlines with fake executors
and harmless Node fixtures. They never start a VM:

```sh
node --test scripts/simulation/qemu-replay.test.mjs
node --test scripts/simulation/prepare-case.test.mjs
```

The case tests additionally use installed filesystem tools for a real read-only
JSON disk round trip. Synthetic TLS setup has a separate maintained test using
the explicitly provisioned builder image; it does not pull images or modify host
trust:

```sh
node --test scripts/simulation/guest-certificates.test.mjs
```

Run all supporting workbench tests after provisioning the pinned images, tools
and trusted SQLite binding:

```sh
yarn simulation:test
```

Builder and guest-coordinator tests should run through their maintained commands
when those files change. A test of fake emulator execution is tooling evidence
only. Before reporting a milestone complete, inspect the actual VM report,
guest checks and recorded source/image identities, then separately assess the
production journey's scenario assertions and unreached cuts.
