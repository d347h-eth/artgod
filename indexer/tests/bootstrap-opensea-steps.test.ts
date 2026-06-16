import { describe, expect, it } from "vitest";
import {
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_STEP_STATUS,
    type BootstrapStepStatus,
} from "@artgod/shared/bootstrap/pipeline";
import {
    areOpenSeaBootstrapStepsTerminal,
    markOpenSeaBootstrapStepDelegatedRunning,
    markOpenSeaBootstrapTerminalFailure,
    type BootstrapOpenSeaStepsPort,
    type OpenSeaBootstrapStepKey,
} from "../src/application/bootstrap-opensea-steps.js";

describe("bootstrap OpenSea steps", () => {
    it("detects when all OpenSea bootstrap steps are terminal", () => {
        const steps = createStepsPort({
            [BOOTSTRAP_STEP_KEY.OpenSeaIdentity]:
                BOOTSTRAP_STEP_STATUS.Succeeded,
            [BOOTSTRAP_STEP_KEY.OpenSeaSnapshot]:
                BOOTSTRAP_STEP_STATUS.Skipped,
            [BOOTSTRAP_STEP_KEY.OpenSeaReady]:
                BOOTSTRAP_STEP_STATUS.FailedTerminal,
        });

        expect(
            areOpenSeaBootstrapStepsTerminal(steps, {
                chainId: 1,
                collectionId: 7,
                bootstrap: { runId: 41 },
            }),
        ).toBe(true);
    });

    it("marks the active OpenSea phase and downstream phases terminal", () => {
        const steps = createStepsPort();

        markOpenSeaBootstrapTerminalFailure({
            stepsPort: steps,
            payload: {
                chainId: 1,
                collectionId: 7,
                bootstrap: { runId: 41 },
            },
            activeStep: BOOTSTRAP_STEP_KEY.OpenSeaSnapshot,
            attempts: 3,
            error: "snapshot failed",
        });

        expect(steps.failedTerminal).toEqual([
            {
                runId: 41,
                stepKey: BOOTSTRAP_STEP_KEY.OpenSeaSnapshot,
                attempts: 3,
                error: "snapshot failed",
            },
            {
                runId: 41,
                stepKey: BOOTSTRAP_STEP_KEY.OpenSeaReady,
                attempts: 3,
                error: "snapshot failed",
            },
        ]);
    });

    it("marks an OpenSea phase as delegated running with a health-check deadline", () => {
        const steps = createStepsPort();

        markOpenSeaBootstrapStepDelegatedRunning({
            stepsPort: steps,
            payload: {
                chainId: 1,
                collectionId: 7,
                bootstrap: { runId: 41 },
            },
            stepKey: BOOTSTRAP_STEP_KEY.OpenSeaSnapshot,
            healthCheckAt: 30_000,
        });

        expect(steps.delegatedRunning).toEqual([
            {
                runId: 41,
                stepKey: BOOTSTRAP_STEP_KEY.OpenSeaSnapshot,
                healthCheckAt: 30_000,
            },
        ]);
    });
});

function createStepsPort(
    statuses: Partial<Record<OpenSeaBootstrapStepKey, BootstrapStepStatus>> = {},
): BootstrapOpenSeaStepsPort & {
    delegatedRunning: Array<{
        runId: number;
        stepKey: OpenSeaBootstrapStepKey;
        healthCheckAt: number;
    }>;
    failedTerminal: Array<{
        runId: number;
        stepKey: OpenSeaBootstrapStepKey;
        attempts: number;
        error: string;
    }>;
} {
    const delegatedRunning: Array<{
        runId: number;
        stepKey: OpenSeaBootstrapStepKey;
        healthCheckAt: number;
    }> = [];
    const failedTerminal: Array<{
        runId: number;
        stepKey: OpenSeaBootstrapStepKey;
        attempts: number;
        error: string;
    }> = [];
    return {
        delegatedRunning,
        failedTerminal,
        getStep: (_runId, stepKey) => {
            const status = statuses[stepKey];
            return status ? { status } : null;
        },
        markStepDelegatedRunning: (input) => {
            delegatedRunning.push(input);
        },
        markStepSucceeded: () => {},
        markStepFailedRetry: () => {},
        markStepFailedTerminal: (input) => {
            failedTerminal.push(input);
        },
    };
}
