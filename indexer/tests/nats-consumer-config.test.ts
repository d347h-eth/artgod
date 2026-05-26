import { describe, expect, it } from "vitest";
import { resolveNatsConsumerConfigUpdate } from "../src/infra/queue/nats.js";

describe("NATS consumer config reconciliation", () => {
    it("updates stale max ack pending from runtime max in-flight config", () => {
        expect(
            resolveNatsConsumerConfigUpdate(
                { max_ack_pending: 1, ack_wait: 30_000_000_000 },
                { maxAckPending: 5 },
            ),
        ).toEqual({ max_ack_pending: 5 });
    });

    it("updates stale ack wait using JetStream nanoseconds", () => {
        expect(
            resolveNatsConsumerConfigUpdate(
                { max_ack_pending: 5, ack_wait: 30_000_000_000 },
                { ackWaitMs: 45_000 },
            ),
        ).toEqual({ ack_wait: 45_000_000_000 });
    });

    it("leaves matching consumer config unchanged", () => {
        expect(
            resolveNatsConsumerConfigUpdate(
                { max_ack_pending: 5, ack_wait: 45_000_000_000 },
                { maxAckPending: 5, ackWaitMs: 45_000 },
            ),
        ).toEqual({});
    });
});
