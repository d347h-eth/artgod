import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBaseEnv } from "../../backend/src/config.test-fixture.js";
import { loadBackendConfig } from "../../backend/src/config.js";
import { startBackendServer } from "../../backend/src/index.js";
import { assertIpv4WildcardPortIsFree } from "./desktop-listener-contract.mjs";

const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "artgod-backend-listener-"),
);
const config = {
    ...loadBackendConfig(createBaseEnv()),
    dbPath: path.join(temporaryRoot, "backend.sqlite"),
    port: 0,
};

try {
    const app = await startBackendServer(config);
    try {
        const address = app.server.address();
        if (!address || typeof address === "string") {
            throw new Error("Backend listener did not report an IP socket.");
        }
        if (address.family !== "IPv4" || address.address !== config.host) {
            throw new Error(
                `Backend reported ${address.address} (${address.family}); expected ${config.host} (IPv4).`,
            );
        }
        await assertIpv4WildcardPortIsFree({
            listenerName: "Backend",
            expectedHost: config.host,
            port: address.port,
        });
    } finally {
        await app.close();
    }
} finally {
    await rm(temporaryRoot, { recursive: true, force: true });
}

console.log("Verified desktop backend IPv4-loopback binding.");
