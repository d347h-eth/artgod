import { describe, expect, it } from "vitest";
import { BOOTSTRAP_ENUMERATION_MODE } from "@artgod/shared/bootstrap/pipeline";
import {
    resolveEnumerableBootstrapTokenIds,
    resolveManualBootstrapTokenIds,
    resolvePresentBootstrapTokenIds,
} from "../src/application/bootstrap-token-enumeration.js";
import type { RpcProviderPort } from "../src/ports/rpc.js";
import { BOOTSTRAP_ENUMERATION_PROGRESS_EVENT_STEP } from "../src/application/bootstrap-enumeration-executor.js";

describe("enumerable bootstrap progress", () => {
    it.each([13, 100, 137, 3333, 10_000, 100_001])(
        "reports each whole percent or token for a supply of %i",
        async (supply) => {
            const progress: Array<{ resolved: number; total: number }> = [];
            let reads = 0;
            const rpc: Pick<RpcProviderPort, "readContract"> = {
                readContract: async <T>(
                    input: Parameters<RpcProviderPort["readContract"]>[0],
                ) => {
                    reads += 1;
                    expect(input.blockNumber).toBe(100);
                    return (
                        input.functionName === "totalSupply"
                            ? BigInt(supply)
                            : BigInt(input.args![0] as bigint) + 1n
                    ) as T;
                },
            };

            const tokenIds = await resolveEnumerableBootstrapTokenIds(
                rpc,
                "0x0000000000000000000000000000000000000001",
                100,
                (value) => progress.push(value),
            );

            expect(reads).toBe(supply + 1);
            expect(tokenIds).toHaveLength(supply);
            expect(tokenIds[0]).toBe("1");
            expect(tokenIds.at(-1)).toBe(String(supply));
            expect(progress[0]).toEqual({ resolved: 0, total: supply });
            expect(progress.at(-1)).toEqual({
                resolved: supply,
                total: supply,
            });
            for (let index = 1; index < progress.length; index += 1) {
                const gap =
                    progress[index].resolved - progress[index - 1].resolved;
                expect(gap).toBeGreaterThan(0);
                expect(gap === 1 || gap / supply <= 0.01).toBe(true);
                expect(gap).toBeLessThanOrEqual(
                    BOOTSTRAP_ENUMERATION_PROGRESS_EVENT_STEP,
                );
                expect(progress[index].total).toBe(supply);
            }
            // Uneven percent checkpoints must still reach the existing event milestones.
            for (
                let resolved = BOOTSTRAP_ENUMERATION_PROGRESS_EVENT_STEP;
                resolved < supply;
                resolved += BOOTSTRAP_ENUMERATION_PROGRESS_EVENT_STEP
            ) {
                expect(progress).toContainEqual({ resolved, total: supply });
            }
        },
    );

    it("reports an empty supply without token reads", async () => {
        const progress: unknown[] = [];
        const reads: string[] = [];
        const rpc: Pick<RpcProviderPort, "readContract"> = {
            readContract: async <T>(
                input: Parameters<RpcProviderPort["readContract"]>[0],
            ) => {
                reads.push(input.functionName);
                return 0n as T;
            },
        };
        expect(
            await resolveEnumerableBootstrapTokenIds(
                rpc,
                "0x0000000000000000000000000000000000000001",
                100,
                (value) => progress.push(value),
            ),
        ).toEqual([]);
        expect(progress).toEqual([{ resolved: 0, total: 0 }]);
        expect(reads).toEqual(["totalSupply"]);
    });
});

describe("bootstrap token enumeration", () => {
    it("leaves enumerable collections for the RPC-backed path", () => {
        expect(
            resolveManualBootstrapTokenIds({
                enumerationMode: BOOTSTRAP_ENUMERATION_MODE.Enumerable,
                manualTokenIdsJson: null,
                manualRangeStartTokenId: null,
                manualRangeTotalSupply: null,
            }),
        ).toBeNull();
    });

    it("parses explicit manual token ids", () => {
        expect(
            Array.from(
                resolveManualBootstrapTokenIds({
                    enumerationMode: BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds,
                    manualTokenIdsJson: JSON.stringify([" 1 ", "42", "9000"]),
                    manualRangeStartTokenId: null,
                    manualRangeTotalSupply: null,
                })!,
            ),
        ).toEqual(["1", "42", "9000"]);
    });

    it("expands manual token ranges from the configured start token", () => {
        expect(
            Array.from(
                resolveManualBootstrapTokenIds({
                    enumerationMode: BOOTSTRAP_ENUMERATION_MODE.ManualRange,
                    manualTokenIdsJson: null,
                    manualRangeStartTokenId: "100",
                    manualRangeTotalSupply: 3,
                })!,
            ),
        ).toEqual(["100", "101", "102"]);
    });

    it("rejects empty or non-numeric manual token ids", () => {
        expect(() =>
            resolveManualBootstrapTokenIds({
                enumerationMode: BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds,
                manualTokenIdsJson: JSON.stringify([]),
                manualRangeStartTokenId: null,
                manualRangeTotalSupply: null,
            }),
        ).toThrow();

        expect(() =>
            resolveManualBootstrapTokenIds({
                enumerationMode: BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds,
                manualTokenIdsJson: JSON.stringify(["1", "abc"]),
                manualRangeStartTokenId: null,
                manualRangeTotalSupply: null,
            }),
        ).toThrow();
    });

    it("rejects incomplete manual token ranges", () => {
        expect(() =>
            resolveManualBootstrapTokenIds({
                enumerationMode: BOOTSTRAP_ENUMERATION_MODE.ManualRange,
                manualTokenIdsJson: null,
                manualRangeStartTokenId: "100",
                manualRangeTotalSupply: 0,
            }),
        ).toThrow();
    });
    it("only seeds minted tokens within the user range", async () => {
        const calls: string[] = [];
        const result = await resolvePresentBootstrapTokenIds(
            ["1", "2", "3"],
            async (tokenId) => {
                calls.push(tokenId);
                return tokenId === "2" ? "owner" : null;
            },
        );
        expect(result).toEqual(["2"]);
        expect(calls).toEqual(["1", "2", "3"]);
    });
    it("does not silently skip uncertain ownership failures", async () => {
        const failure = new Error("provider timeout");
        await expect(
            resolvePresentBootstrapTokenIds(["1", "2"], async () => {
                throw failure;
            }),
        ).rejects.toBe(failure);
    });
    it("rejects an entirely unminted scope", async () => {
        await expect(
            resolvePresentBootstrapTokenIds(["1"], async () => null),
        ).rejects.toThrow("No tokens exist");
    });
});

it("preserves a synthetic Grailers 0-999 declaration while materializing 704 minted IDs", async () => {
    const declaration = {
        enumerationMode: BOOTSTRAP_ENUMERATION_MODE.ManualRange,
        manualRangeStartTokenId: "0",
        manualRangeTotalSupply: 1000,
        manualTokenIdsJson: null,
    };
    const minted = new Set(
        Array.from({ length: 990 }, (_, i) => i + 10)
            .filter((id) => id % 7 !== 0)
            .slice(0, 704)
            .map(String),
    );
    const requested: string[] = [];
    const present = await resolvePresentBootstrapTokenIds(
        resolveManualBootstrapTokenIds(declaration)!,
        async (id) => {
            requested.push(id);
            return minted.has(id) ? "owner" : null;
        },
    );
    expect(present).toEqual([...minted]);
    expect(present).toHaveLength(704);
    expect(requested).toHaveLength(1000);
    expect(requested[0]).toBe("0");
    expect(requested.at(-1)).toBe("999");
    expect(declaration.manualRangeStartTokenId).toBe("0");
    expect(declaration.manualRangeTotalSupply).toBe(1000);
});
