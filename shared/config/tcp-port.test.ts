import { describe, expect, it } from "vitest";
import { TCP_PORT_RANGE, isTcpPort, parseTcpPort } from "./tcp-port.js";

describe("TCP port config", () => {
    it("accepts the complete TCP port range", () => {
        expect(isTcpPort(TCP_PORT_RANGE.Minimum)).toBe(true);
        expect(isTcpPort(String(TCP_PORT_RANGE.Maximum))).toBe(true);
        expect(parseTcpPort(undefined, "TEST_PORT", 42_753)).toBe(42_753);
    });

    it("rejects zero, fractions, and values above the TCP port range", () => {
        expect(isTcpPort(0)).toBe(false);
        expect(isTcpPort("1.5")).toBe(false);
        expect(isTcpPort(TCP_PORT_RANGE.Maximum + 1)).toBe(false);
        expect(() =>
            parseTcpPort(String(TCP_PORT_RANGE.Maximum + 1), "TEST_PORT"),
        ).toThrow("Invalid TEST_PORT");
    });
});
