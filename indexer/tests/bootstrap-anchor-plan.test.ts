import { describe, expect, it } from "vitest";
import { resolveBootstrapAnchorBlock } from "../src/application/bootstrap-anchor-plan.js";

describe("bootstrap anchor plan", () => {
    it("subtracts non-negative reorg depth from the current head", () => {
        expect(
            resolveBootstrapAnchorBlock({
                headBlock: 100,
                reorgDepth: 12,
            }),
        ).toBe(88);
    });

    it("treats negative reorg depth as zero", () => {
        expect(
            resolveBootstrapAnchorBlock({
                headBlock: 100,
                reorgDepth: -5,
            }),
        ).toBe(100);
    });

    it("rejects anchors below the first block", () => {
        expect(
            resolveBootstrapAnchorBlock({
                headBlock: 5,
                reorgDepth: 10,
            }),
        ).toBeNull();
    });
});
