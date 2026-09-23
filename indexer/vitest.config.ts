import { defineConfig } from "vitest/config";

export default defineConfig({
    cacheDir: ".vitest",
    test: {
        environment: "node",
        // Broker fixtures have an explicit runner and require a provisioned binary.
        include: ["tests/**/*.test.ts"],
        globals: true,
        testTimeout: 10_000,
        hookTimeout: 10_000,
    },
});
