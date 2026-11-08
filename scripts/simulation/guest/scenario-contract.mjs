import {
    validateNativeDiagnostics,
    NATIVE_DIAGNOSTIC_CHECK,
} from "./native-failure-evidence.mjs";
import {
    QUALIFICATION_CHECKS,
    DATA_PLANE_CHECK as CHECK,
    DATA_PLANE_CHECKS,
} from "../qualification-protocol.mjs";
import { PROCESS_FAULT_KIND } from "./process-faults.mjs";
import { validateSplitProviderSelection } from "./split-provider-fork.mjs";
import {
    METADATA_TRANSPORT,
    tailBlockIntervalSeconds,
} from "../world/contract.mjs";

export const SCENARIO_KIND = Object.freeze({
    Qualification: "qualification",
    NativeDiagnostic: "native-diagnostic",
    DataPlane: "data-plane",
});
export const DATA_PLANE_JOURNEY = Object.freeze({
    Baseline: "baseline",
    Fork: "fork",
    ProviderDisagreement: "provider-disagreement",
    ProcessRecovery: "process-recovery",
    RefusedProof: "refused-proof",
    StartupMaintenance: "startup-maintenance",
    CollectionBootstrap: "collection-bootstrap",
});
export const RUNTIME_PROFILE = Object.freeze({
    Default: "default",
    Unrestricted: "unrestricted",
});
export const VALIDATION_RELEASE = Object.freeze({
    AfterRollback: "after-rollback",
    BeforeRollback: "before-rollback",
});
export const EXTERNAL_ACTION = Object.freeze({
    CanonicalSwitch: "canonical-switch",
    ReleaseValidation: "release-validation",
    StreamListing: "stream-listing",
    RestoreInventory: "restore-inventory",
});
export const DEFAULT_FORK_SCHEDULE = Object.freeze([
    EXTERNAL_ACTION.CanonicalSwitch,
    EXTERNAL_ACTION.ReleaseValidation,
    EXTERNAL_ACTION.RestoreInventory,
    EXTERNAL_ACTION.StreamListing,
]);

const BASELINE_CHECKS = DATA_PLANE_CHECKS.slice(0, 5);
export const SCENARIO_CHECKS = Object.freeze({
    [SCENARIO_KIND.Qualification]: QUALIFICATION_CHECKS,
    [SCENARIO_KIND.NativeDiagnostic]: [NATIVE_DIAGNOSTIC_CHECK],
    [DATA_PLANE_JOURNEY.Baseline]: BASELINE_CHECKS,
    [DATA_PLANE_JOURNEY.Fork]: [...BASELINE_CHECKS, CHECK.ReorgRecovery],
    [DATA_PLANE_JOURNEY.ProviderDisagreement]: [
        ...BASELINE_CHECKS,
        CHECK.ProviderDisagreement,
    ],
    [DATA_PLANE_JOURNEY.ProcessRecovery]: [
        ...BASELINE_CHECKS,
        CHECK.ProcessRecovery,
    ],
    [DATA_PLANE_JOURNEY.RefusedProof]: [
        CHECK.RuntimeEntrypoints,
        CHECK.ChainAcquisition,
        CHECK.SafeRefusal,
    ],
    [DATA_PLANE_JOURNEY.StartupMaintenance]: [
        ...BASELINE_CHECKS,
        CHECK.StartupMaintenance,
    ],
    [DATA_PLANE_JOURNEY.CollectionBootstrap]: [
        ...BASELINE_CHECKS,
        CHECK.CollectionBootstrap,
    ],
});

/** Host and guest consume the same finite, explicit workload/check contract. */
export function validateScenario(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Scenario must be an object");
    const allowed = [
        "version",
        "kind",
        "qualificationId",
        "expectedChecks",
        "journey",
        "world",
        "schedule",
        "processFault",
        "rpcProviders",
        "runtimeProfile",
        "validationRelease",
        "headProgress",
        "splitProviderFork",
        "staleResultCut",
        "nativeDiagnostics",
    ];
    for (const key of Object.keys(value))
        if (!allowed.includes(key))
            throw new Error(`Unknown scenario field ${key}`);
    if (value.version !== 1) throw new Error("Unsupported scenario version");
    if (!Object.values(SCENARIO_KIND).includes(value.kind))
        throw new Error("Unknown scenario kind");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value.qualificationId ?? ""))
        throw new Error(
            "Scenario qualificationId must be a stable short identifier",
        );
    if (
        value.kind !== SCENARIO_KIND.DataPlane &&
        (value.journey !== undefined || value.world !== undefined)
    )
        throw new Error(
            "Qualification cannot silently include a data-plane journey",
        );
    if (
        value.kind === SCENARIO_KIND.DataPlane &&
        !Object.values(DATA_PLANE_JOURNEY).includes(value.journey)
    )
        throw new Error(
            "Data-plane scenario requires an explicit supported journey",
        );
    const journeyChecks =
        SCENARIO_CHECKS[
            value.kind !== SCENARIO_KIND.DataPlane ? value.kind : value.journey
        ];
    const required =
        value.staleResultCut === true
            ? [...journeyChecks, CHECK.StaleResultSafetyCut]
            : journeyChecks;
    if (
        !Array.isArray(value.expectedChecks) ||
        value.expectedChecks.length !== required.length ||
        new Set(value.expectedChecks).size !== required.length ||
        required.some((check) => !value.expectedChecks.includes(check))
    )
        throw new Error(
            "Scenario expectedChecks must name every check required by its journey exactly once",
        );
    if (
        value.kind === SCENARIO_KIND.NativeDiagnostic &&
        value.nativeDiagnostics === undefined
    )
        throw new Error(
            "The native diagnostic probe requires its explicit profile",
        );
    if (value.nativeDiagnostics !== undefined) {
        validateNativeDiagnostics(value.nativeDiagnostics);
        if (
            value.kind !== SCENARIO_KIND.NativeDiagnostic &&
            !(
                value.kind === SCENARIO_KIND.DataPlane &&
                value.journey === DATA_PLANE_JOURNEY.Fork
            )
        )
            throw new Error(
                "Native diagnostics require the explicit probe or a fork diagnostic case",
            );
    }
    if (value.world !== undefined) {
        if (
            !value.world ||
            typeof value.world !== "object" ||
            Array.isArray(value.world)
        )
            throw new Error("Scenario world must be an object");
        const worldFields = [
            "epochSeconds",
            "maximumBlock",
            "addresses",
            "providers",
            "scripts",
            "transferOnly",
            "metadataTransport",
            "tailBlockIntervalSeconds",
        ];
        for (const key of Object.keys(value.world))
            if (!worldFields.includes(key))
                throw new Error(`Unknown external world field ${key}`);
        if (value.world.tailBlockIntervalSeconds !== undefined)
            tailBlockIntervalSeconds(value.world.tailBlockIntervalSeconds);
        if (
            value.world.metadataTransport !== undefined &&
            !Object.values(METADATA_TRANSPORT).includes(
                value.world.metadataTransport,
            )
        )
            throw new Error(
                "Metadata transport must select modeled HTTP or a data URI",
            );
    }
    if (value.schedule !== undefined) {
        if (
            value.journey !== DATA_PLANE_JOURNEY.Fork ||
            !Array.isArray(value.schedule) ||
            value.schedule.length !== DEFAULT_FORK_SCHEDULE.length ||
            new Set(value.schedule).size !== DEFAULT_FORK_SCHEDULE.length ||
            DEFAULT_FORK_SCHEDULE.some(
                (action) => !value.schedule.includes(action),
            )
        )
            throw new Error(
                "Fork schedule must contain each supported external action exactly once",
            );
    }
    if (value.journey === DATA_PLANE_JOURNEY.ProcessRecovery) {
        if (!Object.values(PROCESS_FAULT_KIND).includes(value.processFault))
            throw new Error(
                "Process recovery requires a supported actual process fault",
            );
    } else if (value.processFault !== undefined)
        throw new Error("Process faults require the process-recovery journey");
    if (
        value.rpcProviders !== undefined &&
        (value.kind !== SCENARIO_KIND.DataPlane ||
            !Array.isArray(value.rpcProviders) ||
            value.rpcProviders.length < 1 ||
            value.rpcProviders.length > 4 ||
            new Set(value.rpcProviders).size !== value.rpcProviders.length ||
            value.rpcProviders.some(
                (provider) =>
                    typeof provider !== "string" ||
                    !/^[a-z0-9_-]+$/i.test(provider),
            ))
    )
        throw new Error(
            "RPC provider selection must be an explicit small list of simulated provider identities",
        );
    if (
        value.runtimeProfile !== undefined &&
        (value.kind !== SCENARIO_KIND.DataPlane ||
            !Object.values(RUNTIME_PROFILE).includes(value.runtimeProfile))
    )
        throw new Error(
            "Runtime profile must select the current defaults or the explicit unrestricted fixture profile",
        );
    if (value.validationRelease !== undefined) {
        if (
            value.journey !== DATA_PLANE_JOURNEY.Fork ||
            !Object.values(VALIDATION_RELEASE).includes(value.validationRelease)
        )
            throw new Error(
                "Validation release witnesses require a supported fork boundary",
            );
        const schedule = value.schedule ?? DEFAULT_FORK_SCHEDULE;
        if (
            value.validationRelease === VALIDATION_RELEASE.BeforeRollback &&
            schedule.indexOf(EXTERNAL_ACTION.ReleaseValidation) >
                schedule.indexOf(EXTERNAL_ACTION.CanonicalSwitch)
        )
            throw new Error(
                "A before-rollback validation witness requires release before the canonical switch",
            );
    }
    if (value.splitProviderFork !== undefined) {
        if (
            value.journey !== DATA_PLANE_JOURNEY.Fork ||
            value.runtimeProfile !== RUNTIME_PROFILE.Default
        )
            throw new Error(
                "Split-provider fork requires the fork journey with actual default runtime budgets",
            );
        validateSplitProviderSelection(
            value.splitProviderFork,
            value.rpcProviders,
        );
        if (
            ![
                value.splitProviderFork.canonicalProvider,
                value.splitProviderFork.retainedProvider,
            ].every((provider) => value.world?.providers?.[provider])
        )
            throw new Error(
                "Split-provider fork must explicitly declare both external provider views",
            );
        if (value.validationRelease === VALIDATION_RELEASE.BeforeRollback)
            throw new Error(
                "A split-provider prologue heals before release and cannot claim A validation committed before rollback",
            );
    }
    if (value.headProgress !== undefined) {
        if (
            value.kind !== SCENARIO_KIND.DataPlane ||
            [
                DATA_PLANE_JOURNEY.ProviderDisagreement,
                DATA_PLANE_JOURNEY.RefusedProof,
            ].includes(value.journey) ||
            !value.headProgress ||
            typeof value.headProgress !== "object" ||
            Array.isArray(value.headProgress) ||
            Object.keys(value.headProgress).join(",") !== "maximumHead" ||
            !Number.isSafeInteger(value.headProgress.maximumHead) ||
            value.headProgress.maximumHead < 107 ||
            value.headProgress.maximumHead > 10_000
        )
            throw new Error(
                "Head progress requires an explicit bounded ceiling for a supported fair-recovery journey",
            );
        if (
            value.journey !== DATA_PLANE_JOURNEY.Fork &&
            (!value.world?.providers?.default ||
                Object.values(value.world.providers).some(
                    (provider) => provider.branch !== "B",
                ))
        )
            throw new Error(
                "Non-fork head progress requires explicitly declared quiet branch B providers",
            );
    }
    if (value.staleResultCut !== undefined) {
        const schedule = value.schedule ?? DEFAULT_FORK_SCHEDULE;
        if (
            value.staleResultCut !== true ||
            value.journey !== DATA_PLANE_JOURNEY.Fork ||
            value.splitProviderFork !== undefined ||
            (value.world?.scripts?.length ?? 0) !== 0 ||
            value.validationRelease === VALIDATION_RELEASE.BeforeRollback ||
            !(
                schedule.indexOf(EXTERNAL_ACTION.CanonicalSwitch) <
                    schedule.indexOf(EXTERNAL_ACTION.ReleaseValidation) &&
                schedule.indexOf(EXTERNAL_ACTION.ReleaseValidation) <
                    schedule.indexOf(EXTERNAL_ACTION.RestoreInventory) &&
                schedule.indexOf(EXTERNAL_ACTION.ReleaseValidation) <
                    schedule.indexOf(EXTERNAL_ACTION.StreamListing)
            )
        )
            throw new Error(
                "The stale-result safety cut requires an isolated fork variant with canonical switch before release and both source actions later",
            );
    }
    return structuredClone(value);
}
