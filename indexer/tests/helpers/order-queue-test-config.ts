import { parseRequiredString } from "@artgod/shared/utils/env";

export const ORDER_QUEUE_TEST_ENV = {
    NatsBinary: "ORDER_QUEUE_TEST_NATS_BINARY",
} as const;
export function loadOrderQueueTestConfig(env: NodeJS.ProcessEnv = process.env) {
    return {
        natsBinary: parseRequiredString(
            env[ORDER_QUEUE_TEST_ENV.NatsBinary],
            ORDER_QUEUE_TEST_ENV.NatsBinary,
        ),
    };
}
