import { afterEach, describe, expect, it, vi } from "vitest";
import { ContractFunctionRevertedError } from "viem";
import {
    ERC721_OWNERSHIP_ABI,
    ERC721_ABSENT_TOKEN_ERROR,
} from "@artgod/shared/evm/erc721-ownership";
import {
    EVM_PROXY_KIND,
    EVM_PROXY_STORAGE_SLOT,
} from "@artgod/shared/evm/proxy-detection";
import { BOOTSTRAP_TOKEN_URI_MAX_BYTES } from "@artgod/shared/config/bootstrap";
import {
    BOOTSTRAP_TEST_ADDRESS as ADDRESS,
    BOOTSTRAP_TEST_OWNER as OWNER,
    BOOTSTRAP_TEST_OBSERVATION as OBSERVATION,
    BOOTSTRAP_CONTRACT_CASES,
} from "@artgod/shared/testing/bootstrap-probe";
import {
    ViemBootstrapContractProbe,
    NON_CONTRACT_ADDRESS_PROBE_ERROR,
} from "./viem-bootstrap-contract-probe.js";

type Rpc = ConstructorParameters<typeof ViemBootstrapContractProbe>[0];
type Read = Parameters<Rpc["readContract"]>[0];
const inline = (text: string) =>
    "data:application/json," + encodeURIComponent(text);
const resilience = {
    requestTimeoutMs: 20,
    retryPolicy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
};
function absent(): Error {
    return new ContractFunctionRevertedError({
        abi: ERC721_OWNERSHIP_ABI,
        functionName: "ownerOf",
        message: ERC721_ABSENT_TOKEN_ERROR.LegacyOwnerQuery,
    });
}
function fixture(
    options: {
        erc721?: boolean | Error;
        enumerable?: boolean | Error;
        supply?: bigint | Error;
        index?: bigint | Error;
        name?: string | Error;
        uri?: string | Error;
        owner?: (id: string) => string | Error;
        rpc?: Partial<Rpc>;
    } = {},
) {
    const calls: Read[] = [];
    const value = (item: unknown) => {
        if (item instanceof Error) throw item;
        return item;
    };
    const rpc: Rpc = {
        getProbeBlock: vi.fn(async () => OBSERVATION),
        getBytecode: vi.fn(async () => "0x01" as const),
        getStorageAt: vi.fn(async () => null),
        async readContract<T>(params: Read): Promise<T> {
            calls.push(params);
            switch (params.functionName) {
                case "supportsInterface":
                    return value(
                        params.args?.[0] === "0x80ac58cd"
                            ? (options.erc721 ?? true)
                            : (options.enumerable ?? true),
                    ) as T;
                case "name":
                    return value(options.name ?? "Sample") as T;
                case "totalSupply":
                    return value(options.supply ?? 100n) as T;
                case "tokenByIndex":
                    return value(options.index ?? 0n) as T;
                case "ownerOf":
                    return value(
                        options.owner?.(String(params.args?.[0])) ?? OWNER,
                    ) as T;
                case "tokenURI":
                    return value(
                        options.uri ??
                            inline('{"image":"https://example.com/0.png"}'),
                    ) as T;
                default:
                    throw new Error(
                        "Unexpected contract read: " + params.functionName,
                    );
            }
        },
        ...options.rpc,
    };
    const adapter = new ViemBootstrapContractProbe(
        rpc,
        "https://ipfs.filebase.io",
        resilience,
    );
    return { adapter, calls, rpc };
}
const metadataInput = {
    address: ADDRESS,
    tokenId: "0",
    observation: OBSERVATION,
};

describe("independent pinned contract discovery", () => {
    afterEach(() => vi.unstubAllGlobals());
    it.each(
        [true, false].flatMap((enumerable) =>
            ["0", "1"].map((start) => ({ enumerable, start })),
        ),
    )(
        "discovers conventional start $start with Enumerable=$enumerable",
        async ({ enumerable, start }) => {
            const { adapter, calls } = fixture({
                enumerable,
                supply: 10000n,
                index: BigInt(start),
                owner: (id) => (start === "1" && id === "0" ? absent() : OWNER),
            });
            const result = await adapter.discoverContract(ADDRESS);
            expect(result.discovery.rangeStartCandidate).toBe(start);
            expect(result.totalSupply.bootstrapRangeValue).toBe(10000);
            expect(result.enumerable.supported).toBe(enumerable);
            expect(
                calls.some((call) => call.functionName === "tokenByIndex"),
            ).toBe(enumerable);
            expect(
                calls
                    .filter((call) => call.functionName === "ownerOf")
                    .map((call) => String(call.args?.[0]))
                    .sort(),
            ).toEqual(["0", "1"]);
        },
    );
    it.each(BOOTSTRAP_CONTRACT_CASES)(
        "keeps $name facts independent from sample reads",
        async (c) => {
            const { adapter, calls } = fixture({
                enumerable: c.enumerable,
                supply: c.supply,
                index: c.name === "meridian" ? 1000000n : BigInt(c.sample),
                owner: (id) =>
                    c.name === "grailers"
                        ? id === "10"
                            ? OWNER
                            : absent()
                        : c.start === "1" && id === "0"
                          ? absent()
                          : OWNER,
            });
            const discovery = await adapter.discoverContract(c.address);
            expect(discovery.enumerable.supported).toBe(c.enumerable);
            expect(discovery.totalSupply.value).toBe(String(c.supply));
            expect(calls.filter((x) => x.functionName === "tokenURI")).toEqual(
                [],
            );
            const before = calls.slice();
            for (const tokenId of [c.sample, "42"])
                await adapter.readMetadata({
                    ...metadataInput,
                    address: c.address,
                    tokenId,
                });
            expect(calls.slice(0, before.length)).toEqual(before);
            expect(
                calls.every((x) => x.blockNumber === OBSERVATION.blockNumber),
            ).toBe(true);
            expect(discovery.discovery.rangeStartCandidate).toBe(
                c.name === "grailers" ? null : c.start === "1" ? "1" : "0",
            );
            expect(
                new Set(
                    calls
                        .filter((x) => x.functionName === "ownerOf")
                        .map((x) => String(x.args?.[0])),
                ).size,
            ).toBe(calls.filter((x) => x.functionName === "ownerOf").length);
        },
    );
    for (const erc721 of [true, false, new Error("ERC165 unavailable")]) {
        for (const enumerable of [
            true,
            false,
            new Error("Enumerable check failed"),
        ]) {
            it(
                "preserves independent interface results: " +
                    String(erc721) +
                    "/" +
                    String(enumerable),
                async () => {
                    const { adapter } = fixture({ erc721, enumerable });
                    const result = await adapter.discoverContract(ADDRESS);
                    expect(result.erc721.supported).toBe(
                        erc721 instanceof Error ? null : erc721,
                    );
                    expect(result.enumerable.supported).toBe(
                        enumerable instanceof Error ? null : enumerable,
                    );
                    expect(result.discovery.enumeration.checked).toBe(
                        enumerable === true,
                    );
                    expect(result.totalSupply.value).toBe("100");
                },
            );
        }
    }
    it.each([
        0n,
        1n,
        1000001n,
        BigInt(Number.MAX_SAFE_INTEGER) + 1n,
        new Error("no supply"),
    ])("classifies supply independently: %s", async (supply) => {
        const { adapter, calls } = fixture({ supply });
        const result = await adapter.discoverContract(ADDRESS);
        expect(result.totalSupply.value).toBe(
            supply instanceof Error ? null : supply.toString(),
        );
        expect(result.totalSupply.bootstrapRangeValue).toBe(
            supply === 1n ? 1 : null,
        );
        expect(calls.some((x) => x.functionName === "tokenByIndex")).toBe(
            supply !== 0n,
        );
    });
    it("does not mistake enumeration order for a numeric minimum, and falls back after failed enumeration", async () => {
        const unordered = await fixture({
            index: 500n,
            owner: (id) => (id === "0" ? absent() : OWNER),
        }).adapter.discoverContract(ADDRESS);
        expect(unordered.discovery).toMatchObject({
            sampleTokenId: "500",
            rangeStartCandidate: "1",
        });
        const failed = await fixture({
            index: new Error("index read failed"),
        }).adapter.discoverContract(ADDRESS);
        expect(failed.discovery).toMatchObject({
            sampleTokenId: "0",
            enumeration: { error: "index read failed" },
        });
        expect(failed.enumerable.supported).toBe(true);
    });
    it("retains unknown ownership, name and proxy failures without inventing absence", async () => {
        const { adapter } = fixture({
            name: new Error("no name"),
            owner: () => new Error("RPC timeout"),
            rpc: {
                async getStorageAt() {
                    throw new Error("storage failed");
                },
            },
        });
        const result = await adapter.discoverContract(ADDRESS);
        expect(result.contractNameError).toBe("no name");
        expect(result.proxyError).toContain("storage failed");
        expect(
            result.discovery.candidates.every((x) => x.exists === null),
        ).toBe(true);
        expect(result.discovery.sampleTokenId).toBeNull();
    });
    it.each(["0x", null] as const)(
        "rejects non-contract code %s before ABI reads",
        async (code) => {
            const { adapter, calls } = fixture({
                rpc: {
                    async getBytecode() {
                        return code;
                    },
                },
            });
            await expect(adapter.discoverContract(ADDRESS)).rejects.toThrow(
                NON_CONTRACT_ADDRESS_PROBE_ERROR,
            );
            expect(calls).toEqual([]);
        },
    );
    it("validates observations and detects a changed block", async () => {
        const { adapter, rpc } = fixture();
        await expect(
            adapter.observation({
                blockNumber: -1,
                blockHash: OBSERVATION.blockHash,
            }),
        ).rejects.toThrow("Invalid probe observation");
        await expect(
            adapter.observation({ ...OBSERVATION, blockHash: "bad" }),
        ).rejects.toThrow("Invalid probe observation");
        await expect(
            adapter.observation({
                ...OBSERVATION,
                blockHash: "0x" + "cc".repeat(32),
            }),
        ).rejects.toThrow("observed block changed");
        await adapter.observation(OBSERVATION);
        expect(rpc.getProbeBlock).toHaveBeenLastCalledWith(
            OBSERVATION.blockNumber,
        );
    });
    it.each([
        EVM_PROXY_KIND.Eip1167Minimal,
        EVM_PROXY_KIND.Erc1967Implementation,
        EVM_PROXY_KIND.Erc1967Beacon,
    ])("keeps NFT reads at the proxy: %s", async (kind) => {
        const implementation = "0xa968ab882ad106b14c3d2c60686315a7c4d0d2f4";
        const beacon = OWNER;
        const word = (address: string) =>
            ("0x" + "0".repeat(24) + address.slice(2)) as `0x${string}`;
        const base = fixture();
        const { adapter, calls } = fixture({
            rpc: {
                async getBytecode() {
                    return kind === EVM_PROXY_KIND.Eip1167Minimal
                        ? "0x363d3d373d3d3d363d73a968ab882ad106b14c3d2c60686315a7c4d0d2f45af43d82803e903d91602b57fd5bf3"
                        : "0x01";
                },
                async getStorageAt(p) {
                    expect(p.blockNumber).toBe(OBSERVATION.blockNumber);
                    if (
                        kind === EVM_PROXY_KIND.Erc1967Implementation &&
                        p.slot === EVM_PROXY_STORAGE_SLOT.Erc1967Implementation
                    )
                        return word(implementation);
                    if (
                        kind === EVM_PROXY_KIND.Erc1967Beacon &&
                        p.slot === EVM_PROXY_STORAGE_SLOT.Erc1967Beacon
                    )
                        return word(beacon);
                    return null;
                },
                async readContract<T>(p: Read): Promise<T> {
                    calls.push(p);
                    if (p.functionName === "implementation") {
                        expect(p.address).toBe(beacon);
                        return implementation as T;
                    }
                    return base.rpc.readContract<T>(p);
                },
            },
        });
        const result = await adapter.discoverContract(ADDRESS);
        expect(result.proxy).toMatchObject({
            kind,
            implementationAddress: implementation,
        });
        expect(
            calls
                .filter((x) => x.functionName !== "implementation")
                .every((x) => x.address === ADDRESS),
        ).toBe(true);
    });
});

describe("sample metadata and the standard HTTP retry policy", () => {
    afterEach(() => vi.unstubAllGlobals());
    it.each([404, 429, 500, 503])(
        "retains tokenURI and reports HTTP %i after configured attempts",
        async (status) => {
            const fetcher = vi.fn(
                async (_url: unknown) =>
                    new Response("unavailable", { status }),
            );
            vi.stubGlobal("fetch", fetcher);
            const { adapter } = fixture({ uri: "ipfs://sample/1" });
            const result = await adapter.readMetadata(metadataInput);
            expect(result.tokenUri).toBe("ipfs://sample/1");
            expect(result.tokenUriPayloadError).toContain("HTTP " + status);
            expect(fetcher).toHaveBeenCalledTimes(
                status === 404 ? 1 : resilience.retryPolicy.maxAttempts,
            );
            expect(String(fetcher.mock.calls[0]?.[0])).toBe(
                "https://ipfs.filebase.io/ipfs/sample/1",
            );
        },
    );
    it("retries transport failures and explicit retry uses the same policy", async () => {
        const fetcher = vi.fn(async () => {
            throw new TypeError("connection failed");
        });
        vi.stubGlobal("fetch", fetcher);
        const { adapter } = fixture({ uri: "https://example.com/1" });
        await adapter.readMetadata(metadataInput);
        await adapter.readMetadata(metadataInput);
        expect(fetcher).toHaveBeenCalledTimes(
            resilience.retryPolicy.maxAttempts * 2,
        );
    });
    it("times out through the configured common fetch policy", async () => {
        const fetcher = vi.fn(
            async (_url: unknown, init?: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () =>
                        reject(new Error("aborted")),
                    );
                }),
        );
        vi.stubGlobal("fetch", fetcher);
        const result = await fixture({
            uri: "https://example.com/1",
        }).adapter.readMetadata(metadataInput);
        expect(result.tokenUriPayloadError).toContain("timed out");
        expect(fetcher).toHaveBeenCalledTimes(
            resilience.retryPolicy.maxAttempts,
        );
    });
    it.each([new Error("reverted"), ""])(
        "keeps a tokenURI failure separate: %s",
        async (uri) => {
            const result = await fixture({ uri }).adapter.readMetadata(
                metadataInput,
            );
            expect(result.tokenUriError).not.toBeNull();
            expect(result.tokenUriPayloadError).toBeNull();
        },
    );
    it.each(["{broken", "null", "[]", ""])(
        "preserves invalid metadata text: %s",
        async (text) => {
            const result = await fixture({
                uri: inline(text),
            }).adapter.readMetadata(metadataInput);
            expect(result.tokenUriPayload).toBe(text);
            expect(result.metadataError).not.toBeNull();
            expect(result.tokenUriPayloadError).toBeNull();
        },
    );
    it("keeps large embedded artwork as bounded text and never fetches the image", async () => {
        const text = JSON.stringify({
            image: "https://example.com/image.png",
            animation_url: "data:text/html,<script>alert(1)</script>",
            artwork: "A".repeat(60000),
        });
        const fetcher = vi.fn(async () => new Response(text));
        vi.stubGlobal("fetch", fetcher);
        const result = await fixture({
            uri: "https://example.com/1",
        }).adapter.readMetadata(metadataInput);
        expect(result.tokenUriPayload).toBe(text);
        expect(result.tokenUriPayloadBytes).toBe(Buffer.byteLength(text));
        expect(fetcher).toHaveBeenCalledTimes(1);
        const base64 = await fixture({
            uri:
                "data:application/json;base64," +
                Buffer.from(text).toString("base64"),
        }).adapter.readMetadata(metadataInput);
        expect(base64.tokenUriPayload).toBe(text);
    });
    it.each(["inline", "header", "stream"] as const)(
        "bounds %s metadata",
        async (mode) => {
            const text = "x".repeat(BOOTSTRAP_TOKEN_URI_MAX_BYTES + 1);
            vi.stubGlobal(
                "fetch",
                vi.fn(
                    async () =>
                        new Response(
                            text,
                            mode === "header"
                                ? {
                                      headers: {
                                          "content-length": String(text.length),
                                      },
                                  }
                                : undefined,
                        ),
                ),
            );
            const result = await fixture({
                uri:
                    mode === "inline"
                        ? inline(text)
                        : "https://example.com/large",
            }).adapter.readMetadata(metadataInput);
            expect(result.tokenUriPayload).toBeNull();
            expect(result.tokenUriPayloadError).not.toBeNull();
        },
    );
});
