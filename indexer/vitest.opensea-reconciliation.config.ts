import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include: ["integration/opensea-reconciliation.test.ts"],
        fileParallelism: false,
    },
});
