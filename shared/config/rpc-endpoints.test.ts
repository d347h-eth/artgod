import { describe, expect, it } from "vitest";
import {
    parseRpcEndpointConfigList,
    serializeRpcEndpointConfigList,
    WeightedRpcEndpointSelector,
} from "./rpc-endpoints.js";

describe("RPC endpoint config", () => {
    it("parses legacy single URL config as weight one", () => {
        expect(parseRpcEndpointConfigList("http://127.0.0.1:42721")).toEqual([
            { url: "http://127.0.0.1:42721", weight: 1 },
        ]);
    });

    it("parses weighted JSON endpoint lists", () => {
        expect(
            parseRpcEndpointConfigList(
                '[{"url":"https://rpc-a.example","weight":3},{"url":"https://rpc-b.example"}]',
            ),
        ).toEqual([
            { url: "https://rpc-a.example", weight: 3 },
            { url: "https://rpc-b.example", weight: 1 },
        ]);
    });

    it("parses compact operator endpoint lists", () => {
        expect(
            parseRpcEndpointConfigList(
                "https://rpc-a.example|2;https://rpc-b.example|1",
            ),
        ).toEqual([
            { url: "https://rpc-a.example", weight: 2 },
            { url: "https://rpc-b.example", weight: 1 },
        ]);
    });

    it("rejects websocket URLs for HTTP JSON-RPC endpoint pools", () => {
        expect(() => parseRpcEndpointConfigList("wss://rpc.example")).toThrow(
            "URL is invalid",
        );
    });

    it("rejects URLs without an explicit scheme separator", () => {
        expect(() =>
            parseRpcEndpointConfigList("https:localhost:8545"),
        ).toThrow("URL is invalid");
    });

    it("serializes normalized endpoint lists", () => {
        expect(
            serializeRpcEndpointConfigList([
                { url: "https://rpc-a.example", weight: 2 },
                { url: "https://rpc-b.example", weight: 1 },
            ]),
        ).toBe(
            '[{"url":"https://rpc-a.example","weight":2},{"url":"https://rpc-b.example","weight":1}]',
        );
    });
});

describe("WeightedRpcEndpointSelector", () => {
    it("selects endpoints according to configured weights", () => {
        const selector = new WeightedRpcEndpointSelector([
            { url: "https://rpc-a.example", weight: 2, value: "a" },
            { url: "https://rpc-b.example", weight: 1, value: "b" },
        ]);

        const selected = Array.from(
            { length: 6 },
            () => selector.select().value,
        );

        expect(selected.filter((value) => value === "a")).toHaveLength(4);
        expect(selected.filter((value) => value === "b")).toHaveLength(2);
    });

    it("drifts selection away from failing endpoints without persistence", () => {
        const selector = new WeightedRpcEndpointSelector([
            { id: "a", url: "https://rpc-a.example", weight: 4, value: "a" },
            { id: "b", url: "https://rpc-b.example", weight: 4, value: "b" },
        ]);

        selector.recordFailure("a");
        selector.recordFailure("a");

        const state = selector.snapshot();

        expect(state.find((entry) => entry.id === "a")?.effectiveWeight).toBe(
            1,
        );
        expect(state.find((entry) => entry.id === "b")?.effectiveWeight).toBe(
            4,
        );
    });
});
