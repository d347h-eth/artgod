import { defineConfig } from "vitest/config";
export default defineConfig({
    test: {
        environment: "node",
        include: [
            "integration/order-queue-healing.test.ts",
            "integration/order-backlog.test.ts",
        ],
        fileParallelism: false,
    },
});
