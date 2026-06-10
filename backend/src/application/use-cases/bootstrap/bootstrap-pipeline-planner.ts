import type { OpenSeaIntegrationStatus } from "@artgod/shared/config/opensea-integration";
import type { CollectionExtensionKey } from "@artgod/shared/extensions";
import {
    isImageCachePolicyActive,
    type ImageCachePolicyConfig,
} from "@artgod/shared/media/token-image-cache";
import {
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_STEP_STATUS,
    type BootstrapRunStepPlan,
    type BootstrapStepKey,
    type BootstrapStepStatus,
} from "@artgod/shared/bootstrap/pipeline";

export type BootstrapPipelinePlanInput = {
    imageCache: ImageCachePolicyConfig;
    openseaSlug: string | null;
    openseaIntegration: OpenSeaIntegrationStatus;
    requestExtensionKey: CollectionExtensionKey | null;
};

// Plans the persisted bootstrap graph from the immutable request-time decisions.
export function planBootstrapRunSteps(
    input: BootstrapPipelinePlanInput,
): BootstrapRunStepPlan[] {
    const steps: BootstrapRunStepPlan[] = [
        blockingStep({
            stepKey: BOOTSTRAP_STEP_KEY.Anchor,
            status: BOOTSTRAP_STEP_STATUS.Ready,
        }),
        blockingStep({
            stepKey: BOOTSTRAP_STEP_KEY.Enumeration,
            dependsOn: [BOOTSTRAP_STEP_KEY.Anchor],
        }),
        blockingStep({
            stepKey: BOOTSTRAP_STEP_KEY.Metadata,
            dependsOn: [BOOTSTRAP_STEP_KEY.Enumeration],
        }),
        blockingStep({
            stepKey: BOOTSTRAP_STEP_KEY.Ownership,
            dependsOn: [BOOTSTRAP_STEP_KEY.Metadata],
        }),
        blockingStep({
            stepKey: BOOTSTRAP_STEP_KEY.Backfill,
            dependsOn: [BOOTSTRAP_STEP_KEY.Ownership],
        }),
        blockingStep({
            stepKey: BOOTSTRAP_STEP_KEY.CollectionLive,
            dependsOn: [BOOTSTRAP_STEP_KEY.Backfill],
        }),
    ];

    if (isImageCachePolicyActive(input.imageCache)) {
        steps.push(
            sideLaneStep({
                stepKey: BOOTSTRAP_STEP_KEY.ImageCache,
                dependsOn: [BOOTSTRAP_STEP_KEY.Metadata],
                config: {
                    imageCacheMode: input.imageCache.imageCacheMode,
                    maxDimension: input.imageCache.maxDimension,
                },
            }),
        );
    }

    if (input.requestExtensionKey) {
        steps.push(
            sideLaneStep({
                stepKey: BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts,
                dependsOn: [BOOTSTRAP_STEP_KEY.Metadata],
                config: {
                    extensionKey: input.requestExtensionKey,
                },
            }),
        );
    }

    if (input.openseaIntegration.enabled && input.openseaSlug) {
        steps.push(
            sideLaneStep({
                stepKey: BOOTSTRAP_STEP_KEY.OpenSeaIdentity,
                dependsOn: [
                    BOOTSTRAP_STEP_KEY.Metadata,
                    BOOTSTRAP_STEP_KEY.Ownership,
                ],
                config: {
                    openseaSlug: input.openseaSlug,
                },
            }),
            sideLaneStep({
                stepKey: BOOTSTRAP_STEP_KEY.OpenSeaSnapshot,
                dependsOn: [BOOTSTRAP_STEP_KEY.OpenSeaIdentity],
            }),
            sideLaneStep({
                stepKey: BOOTSTRAP_STEP_KEY.OpenSeaReady,
                dependsOn: [BOOTSTRAP_STEP_KEY.OpenSeaSnapshot],
            }),
        );
    }

    return steps;
}

function blockingStep(input: {
    stepKey: BootstrapStepKey;
    status?: BootstrapStepStatus;
    dependsOn?: readonly BootstrapStepKey[];
    config?: Record<string, unknown> | null;
}): BootstrapRunStepPlan {
    return stepPlan({ ...input, blocking: true });
}

function sideLaneStep(input: {
    stepKey: BootstrapStepKey;
    status?: BootstrapStepStatus;
    dependsOn?: readonly BootstrapStepKey[];
    config?: Record<string, unknown> | null;
}): BootstrapRunStepPlan {
    return stepPlan({ ...input, blocking: false });
}

function stepPlan(input: {
    stepKey: BootstrapStepKey;
    blocking: boolean;
    status?: BootstrapStepStatus;
    dependsOn?: readonly BootstrapStepKey[];
    config?: Record<string, unknown> | null;
}): BootstrapRunStepPlan {
    return {
        stepKey: input.stepKey,
        status: input.status ?? BOOTSTRAP_STEP_STATUS.Pending,
        blocking: input.blocking,
        dependsOn: input.dependsOn ?? [],
        progressTotal: null,
        config: input.config ?? null,
    };
}
