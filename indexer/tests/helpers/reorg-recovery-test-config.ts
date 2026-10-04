import { parseRequiredString } from "@artgod/shared/utils/env";
export const REORG_RECOVERY_TEST_ENV = {
    NatsBinary: "REORG_RECOVERY_TEST_NATS_BINARY",
} as const;
export function loadReorgRecoveryTestConfig(
    env: NodeJS.ProcessEnv = process.env,
) {
    return {
        natsBinary: parseRequiredString(
            env[REORG_RECOVERY_TEST_ENV.NatsBinary],
            REORG_RECOVERY_TEST_ENV.NatsBinary,
        ),
    };
}
