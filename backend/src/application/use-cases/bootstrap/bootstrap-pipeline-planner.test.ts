import { describe, expect, it } from "vitest";
import type { OpenSeaIntegrationStatus } from "@artgod/shared/config/opensea-integration";
import { IMAGE_CACHE_MODE } from "@artgod/shared/media/token-image-cache";
import {
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_STEP_STATUS,
} from "@artgod/shared/bootstrap/pipeline";
import { TERRAFORMS_EXTENSION_KEY } from "@artgod/shared/extensions/terraforms";
import { planBootstrapRunSteps } from "./bootstrap-pipeline-planner.js";

const DISABLED_OPENSEA_INTEGRATION: OpenSeaIntegrationStatus = {
    enabled: false,
    mode: "disabled",
    reason: "disabled",
    missingKeys: [],
    requiredKeys: [],
};

const ENABLED_OPENSEA_INTEGRATION: OpenSeaIntegrationStatus = {
    enabled: true,
    mode: "enabled",
    reason: null,
    missingKeys: [],
    requiredKeys: [],
};

describe("bootstrap pipeline planner", () => {
    it("plans the blocking local correctness path", () => {
        const steps = planBootstrapRunSteps({
            imageCache: {
                imageCacheMode: IMAGE_CACHE_MODE.Off,
                maxDimension: null,
            },
            openseaSlug: null,
            openseaIntegration: DISABLED_OPENSEA_INTEGRATION,
            requestExtensionKey: null,
        });

        expect(steps.map((step) => step.stepKey)).toEqual([
            BOOTSTRAP_STEP_KEY.Anchor,
            BOOTSTRAP_STEP_KEY.Enumeration,
            BOOTSTRAP_STEP_KEY.Metadata,
            BOOTSTRAP_STEP_KEY.Ownership,
            BOOTSTRAP_STEP_KEY.Backfill,
            BOOTSTRAP_STEP_KEY.CollectionLive,
        ]);
        expect(steps[0]).toEqual(
            expect.objectContaining({
                status: BOOTSTRAP_STEP_STATUS.Ready,
                blocking: true,
                dependsOn: [],
            }),
        );
        expect(steps.every((step) => step.blocking)).toBe(true);
    });

    it("adds non-blocking image-cache, extension, and OpenSea side lanes", () => {
        const steps = planBootstrapRunSteps({
            imageCache: {
                imageCacheMode: IMAGE_CACHE_MODE.CacheOnce,
                maxDimension: 512,
            },
            openseaSlug: "milady-by-remilia-corporation",
            openseaIntegration: ENABLED_OPENSEA_INTEGRATION,
            requestExtensionKey: TERRAFORMS_EXTENSION_KEY,
        });
        const byKey = new Map(steps.map((step) => [step.stepKey, step]));

        expect(byKey.get(BOOTSTRAP_STEP_KEY.ImageCache)).toEqual(
            expect.objectContaining({
                blocking: false,
                dependsOn: [BOOTSTRAP_STEP_KEY.Metadata],
                config: {
                    imageCacheMode: IMAGE_CACHE_MODE.CacheOnce,
                    maxDimension: 512,
                },
            }),
        );
        expect(
            byKey.get(BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts),
        ).toEqual(
            expect.objectContaining({
                blocking: false,
                dependsOn: [BOOTSTRAP_STEP_KEY.Metadata],
                config: {
                    extensionKey: TERRAFORMS_EXTENSION_KEY,
                },
            }),
        );
        expect(byKey.get(BOOTSTRAP_STEP_KEY.OpenSeaIdentity)).toEqual(
            expect.objectContaining({
                blocking: false,
                dependsOn: [
                    BOOTSTRAP_STEP_KEY.Metadata,
                    BOOTSTRAP_STEP_KEY.Ownership,
                ],
                config: {
                    openseaSlug: "milady-by-remilia-corporation",
                },
            }),
        );
        expect(byKey.get(BOOTSTRAP_STEP_KEY.OpenSeaSnapshot)).toEqual(
            expect.objectContaining({
                dependsOn: [BOOTSTRAP_STEP_KEY.OpenSeaIdentity],
            }),
        );
        expect(byKey.get(BOOTSTRAP_STEP_KEY.OpenSeaReady)).toEqual(
            expect.objectContaining({
                dependsOn: [BOOTSTRAP_STEP_KEY.OpenSeaSnapshot],
            }),
        );
    });
});
