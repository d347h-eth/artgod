import { describe, expect, it } from "vitest";
import { RUNTIME_METRIC_DEFAULT_LABEL } from "../../shared/observability/metrics/runtime.js";
import {
    BIDDING_RUNTIME_FORBIDDEN_HIGH_CARDINALITY_LABELS,
    BIDDING_RUNTIME_METRIC_NAME,
} from "../../trading/src/adapters/observability/bidding-runtime-metric-contract.js";
import { TRADING_METRICS_PREFIX } from "../../trading/src/runtime/observability.js";
import {
    buildDashboard,
    validateDashboard,
} from "./generate-bidding-runtime-dashboard.js";

const metric = `${TRADING_METRICS_PREFIX}${BIDDING_RUNTIME_METRIC_NAME.JobScanDuration}_count`;
const runtimeLegend = Object.values(RUNTIME_METRIC_DEFAULT_LABEL)
    .map((label) => `{{${label}}}`)
    .join(" / ");

function dashboardWithTarget(expr: string, legendFormat = runtimeLegend) {
    return { panels: [{ targets: [{ expr, legendFormat }] }] };
}

describe("bidding dashboard contract", () => {
    it("accepts the complete generated dashboard", () => {
        expect(() => validateDashboard(buildDashboard())).not.toThrow();
    });

    // These operators deliberately assert PromQL wire syntax at the validation boundary.
    it.each(
        BIDDING_RUNTIME_FORBIDDEN_HIGH_CARDINALITY_LABELS.flatMap((label) =>
            ["=", "=~", "!=", "!~"].map((operator) => ({ label, operator })),
        ),
    )("rejects $label $operator selectors", ({ label, operator }) => {
        expect(() =>
            validateDashboard(
                dashboardWithTarget(`${metric}{${label}${operator}"example"}`),
            ),
        ).toThrow(/high-cardinality label/);
    });

    it.each(BIDDING_RUNTIME_FORBIDDEN_HIGH_CARDINALITY_LABELS)(
        "rejects grouping and legends using %s",
        (label) => {
            expect(() =>
                validateDashboard(
                    dashboardWithTarget(`sum by (${label}) (${metric})`),
                ),
            ).toThrow(/high-cardinality label/);
            expect(() =>
                validateDashboard(
                    dashboardWithTarget(
                        metric,
                        `${runtimeLegend} / {{${label}}}`,
                    ),
                ),
            ).toThrow(/high-cardinality label/);
        },
    );

    it("keeps bounded runtime matchers and rejects undeclared metric names", () => {
        expect(() =>
            validateDashboard(
                dashboardWithTarget(
                    `${metric}{${RUNTIME_METRIC_DEFAULT_LABEL.ChainId}!=""}`,
                ),
            ),
        ).not.toThrow();
        expect(() =>
            validateDashboard(dashboardWithTarget(`${metric}_undeclared`)),
        ).toThrow(/unknown bidding metric/);
    });
});
