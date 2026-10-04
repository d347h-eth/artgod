import { defineConfig } from "vitest/config";
export default defineConfig({
    test: {
        environment: "node",
        include: ["integration/reorg-recovery.test.ts"],
        fileParallelism: false,
        testTimeout: 30_000,
        hookTimeout: 30_000,
    },
});
