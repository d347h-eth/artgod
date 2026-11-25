import { defineConfig } from "vitest/config";
export default defineConfig({
    test: {
        environment: "node",
        include: [
            "integration/orderbook-worker.test.ts",
            "integration/orderbook-cutover.test.ts",
        ],
        fileParallelism: false,
    },
});
