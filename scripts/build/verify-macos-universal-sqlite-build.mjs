#!/usr/bin/env node
import { buildSqliteNativeBinding } from "./build-sqlite-native-binding.mjs";
import {
    DESKTOP_BUILD_TARGET_ENV_KEYS,
    DESKTOP_NODE_DIST_TARGET,
} from "./native-runtime-dependencies.mjs";

// Exercise the real node-gyp and lipo path on the ordinary macOS CI runner.
await buildSqliteNativeBinding({
    environment: {
        ...process.env,
        [DESKTOP_BUILD_TARGET_ENV_KEYS.NodeDistributionTarget]:
            DESKTOP_NODE_DIST_TARGET.DarwinUniversal,
    },
});
