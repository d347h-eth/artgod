import { describe, expect, it } from "vitest";
import {
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_STEP_STATUS,
} from "@artgod/shared/bootstrap/pipeline";
import {
    resolveReadyBootstrapSteps,
    resolveWakeableBootstrapSteps,
    type BootstrapReconcilerStep,
} from "../src/application/bootstrap-step-reconciler.js";

describe("bootstrap step reconciler", () => {
    it("resolves pending steps whose dependencies are satisfied", () => {
        const steps: BootstrapReconcilerStep[] = [
            step(BOOTSTRAP_STEP_KEY.Anchor, BOOTSTRAP_STEP_STATUS.Succeeded),
            step(BOOTSTRAP_STEP_KEY.Enumeration, BOOTSTRAP_STEP_STATUS.Pending, [
                BOOTSTRAP_STEP_KEY.Anchor,
            ]),
            step(BOOTSTRAP_STEP_KEY.Metadata, BOOTSTRAP_STEP_STATUS.Pending, [
                BOOTSTRAP_STEP_KEY.Enumeration,
            ]),
            step(BOOTSTRAP_STEP_KEY.ImageCache, BOOTSTRAP_STEP_STATUS.Pending, [
                BOOTSTRAP_STEP_KEY.Metadata,
            ]),
        ];

        expect(resolveReadyBootstrapSteps(steps)).toEqual([
            BOOTSTRAP_STEP_KEY.Enumeration,
        ]);
    });

    it("wakes newly ready and persisted retryable steps", () => {
        const steps: BootstrapReconcilerStep[] = [
            step(BOOTSTRAP_STEP_KEY.Anchor, BOOTSTRAP_STEP_STATUS.Succeeded),
            step(BOOTSTRAP_STEP_KEY.Enumeration, BOOTSTRAP_STEP_STATUS.Pending, [
                BOOTSTRAP_STEP_KEY.Anchor,
            ]),
            step(BOOTSTRAP_STEP_KEY.Metadata, BOOTSTRAP_STEP_STATUS.FailedRetry, [
                BOOTSTRAP_STEP_KEY.Enumeration,
            ]),
            step(BOOTSTRAP_STEP_KEY.ImageCache, BOOTSTRAP_STEP_STATUS.Paused, [
                BOOTSTRAP_STEP_KEY.Metadata,
            ]),
        ];

        expect(
            resolveWakeableBootstrapSteps(steps, [
                BOOTSTRAP_STEP_KEY.Enumeration,
            ]),
        ).toEqual([
            BOOTSTRAP_STEP_KEY.Enumeration,
            BOOTSTRAP_STEP_KEY.Metadata,
        ]);
    });
});

function step(
    stepKey: BootstrapReconcilerStep["stepKey"],
    status: BootstrapReconcilerStep["status"],
    dependsOn: BootstrapReconcilerStep["dependsOn"] = [],
): BootstrapReconcilerStep {
    return { stepKey, status, dependsOn };
}
