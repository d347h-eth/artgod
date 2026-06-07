import { describe, expect, it } from "vitest";
import {
    RPC_AUTO_SOURCING_TRACKING_POLICIES,
    normalizeRpcAutoSourcingTrackingPolicy,
} from "./rpc-auto-sourcing.js";

describe("RPC auto sourcing config", () => {
    it("normalizes invalid tracking policies to no tracking", () => {
        expect(normalizeRpcAutoSourcingTrackingPolicy(undefined)).toBe(
            RPC_AUTO_SOURCING_TRACKING_POLICIES.none,
        );
        expect(normalizeRpcAutoSourcingTrackingPolicy("unexpected")).toBe(
            RPC_AUTO_SOURCING_TRACKING_POLICIES.none,
        );
    });

    it("accepts the explicit tracking policies", () => {
        expect(
            normalizeRpcAutoSourcingTrackingPolicy(
                RPC_AUTO_SOURCING_TRACKING_POLICIES.none,
            ),
        ).toBe(RPC_AUTO_SOURCING_TRACKING_POLICIES.none);
        expect(
            normalizeRpcAutoSourcingTrackingPolicy(
                RPC_AUTO_SOURCING_TRACKING_POLICIES.limited,
            ),
        ).toBe(RPC_AUTO_SOURCING_TRACKING_POLICIES.limited);
        expect(
            normalizeRpcAutoSourcingTrackingPolicy(
                RPC_AUTO_SOURCING_TRACKING_POLICIES.all,
            ),
        ).toBe(RPC_AUTO_SOURCING_TRACKING_POLICIES.all);
    });
});
