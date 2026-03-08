import { defineConfig } from "vitest/config";

export default defineConfig({
    cacheDir: ".vitest",
    test: {
        environment: "node",
        globals: true,
        testTimeout: 10_000,
        hookTimeout: 10_000,
    },
});
