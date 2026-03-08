import { defineWorkspace } from "vitest/config";

const dbBackedTests = [
    "tests/metadata-stats.test.ts",
    "tests/token-sets.test.ts",
    "tests/smoke.test.ts",
    "tests/offchain-dispatch.test.ts",
    "tests/orders-raw-source.test.ts",
    "tests/orders-update-by-maker.test.ts",
];

export default defineWorkspace([
    {
        extends: "./vitest.config.ts",
        test: {
            name: "unit",
            cacheDir: ".vitest/unit",
            exclude: dbBackedTests,
        },
    },
    {
        extends: "./vitest.config.ts",
        test: {
            name: "db",
            cacheDir: ".vitest/db",
            include: dbBackedTests,
            fileParallelism: false,
            maxConcurrency: 1,
            sequence: {
                concurrent: false,
            },
        },
    },
]);
