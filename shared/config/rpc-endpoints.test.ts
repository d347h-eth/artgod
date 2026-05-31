import { describe, expect, it } from "vitest";
import {
    parseRpcEndpointConfigList,
    serializeRpcEndpointConfigList,
    WeightedRpcEndpointSelector,
} from "./rpc-endpoints.js";

describe("RPC endpoint config", () => {
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

    it("defaults omitted endpoint weights to one", () => {
        expect(
            parseRpcEndpointConfigList('[{"url":"https://rpc-a.example"}]'),
        ).toEqual([{ url: "https://rpc-a.example", weight: 1 }]);
    });

    it("rejects plain URL endpoint values", () => {
        expect(() =>
            parseRpcEndpointConfigList("http://127.0.0.1:42721"),
        ).toThrow("endpoint list must be a JSON array");
    });

    it("rejects non-object endpoint entries", () => {
        expect(() =>
            parseRpcEndpointConfigList('["https://rpc-a.example"]'),
        ).toThrow("endpoint 1 must be an object");
    });

    it("rejects websocket URLs for HTTP JSON-RPC endpoint pools", () => {
        expect(() =>
            parseRpcEndpointConfigList('[{"url":"wss://rpc.example"}]'),
        ).toThrow("URL is invalid");
    });

    it("rejects URLs without an explicit scheme separator", () => {
        expect(() =>
            parseRpcEndpointConfigList(
                '[{"url":"https:localhost:8545","weight":1}]',
            ),
        ).toThrow("URL is invalid");
    });

    it("rejects null endpoint weights", () => {
        expect(() =>
            parseRpcEndpointConfigList(
                '[{"url":"https://rpc-a.example","weight":null}]',
            ),
        ).toThrow("weight must be a positive integer");
    });

    it("rejects JSON objects that are not endpoint arrays", () => {
        expect(() =>
            parseRpcEndpointConfigList(
                '{"url":"https://rpc-a.example","weight":1}',
            ),
        ).toThrow("endpoint list must be a JSON array");
    });

    it("rejects compact endpoint list values", () => {
        expect(() =>
            parseRpcEndpointConfigList(
                "https://rpc-a.example|2;https://rpc-b.example|1",
            ),
        ).toThrow("endpoint list must be a JSON array");
    });

    it("rejects empty endpoint arrays", () => {
        expect(() => parseRpcEndpointConfigList("[]")).toThrow(
            "endpoint list cannot be empty",
        );
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
