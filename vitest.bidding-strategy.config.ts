import { defineConfig } from "vitest/config";

// Keep each strategy boundary covered independently so one file cannot mask another.
const strategyCoverageThresholds = {
    "trading/src/application/use-cases/bidding/bidder.ts": {
        statements: 88,
        branches: 78,
        functions: 94,
        lines: 88,
    },
    "shared/trading/open-sea-offer-price.ts": { 100: true },
    "shared/trading/open-sea-bidding-offers.ts": {
        statements: 89,
        branches: 85,
        functions: 93,
        lines: 89,
    },
    "trading/src/adapters/opensea/open-sea-bidding-service.ts": {
        statements: 79,
        branches: 69,
        functions: 91,
        lines: 79,
    },
};

export default defineConfig({
    test: {
        environment: "node",
        include: [
            "trading/src/**/*.test.ts",
            "shared/trading/open-sea-offer-price.test.ts",
            "shared/trading/open-sea-bidding-offers.test.ts",
        ],
        coverage: {
            provider: "v8",
            include: Object.keys(strategyCoverageThresholds),
            thresholds: strategyCoverageThresholds,
            reporter: ["text", "json-summary", "json", "html"],
            reportsDirectory: "./tmp/bidding-strategy-coverage",
            clean: false,
        },
    },
});
