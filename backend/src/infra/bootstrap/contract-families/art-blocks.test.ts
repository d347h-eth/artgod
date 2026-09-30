import { afterEach, describe, expect, it, vi } from "vitest";
import {
    ContractFunctionRevertedError,
    encodeAbiParameters,
    getFunctionSelector,
    parseAbiParameters,
} from "viem";
import { ViemBackendRpcClient } from "../../rpc/viem-backend-rpc.js";
import { NOOP_APM } from "@artgod/shared/observability/apm";
import {
    getDefaultRpcRetryPolicy,
    getDefaultRpcEndpointResilienceConfig,
} from "@artgod/shared/config/rpc-resilience";
import { BOOTSTRAP_SHARED_CONTRACT_REASON as Reason } from "@artgod/shared/bootstrap/probe";
import {
    BOOTSTRAP_OUTPUT_STATUS as Status,
    type BootstrapOutput,
} from "@artgod/shared/bootstrap/operation-output";
import {
    BOOTSTRAP_TEST_ADDRESS,
    BOOTSTRAP_TEST_OBSERVATION,
    BOOTSTRAP_TEST_OWNER,
} from "@artgod/shared/testing/bootstrap-probe";
import type { BootstrapProbeRpc } from "../viem-bootstrap-contract-probe.js";
import {
    ART_BLOCKS_FUNCTION as F,
    ART_BLOCKS_MAINNET_REGISTRY as Registry,
    probeArtBlocksSharedContract,
    inspectArtBlocksProjectScope,
    ART_BLOCKS_PROJECT_TOKEN_STRIDE as STRIDE,
    ART_BLOCKS_V3_CORE_TYPES,
} from "./art-blocks.js";
import { EVM_TOKEN_ID_MAX } from "@artgod/shared/evm/token-id";

type Read = Parameters<BootstrapProbeRpc["readContract"]>[0];
const input = {
    address: BOOTSTRAP_TEST_ADDRESS as `0x${string}`,
    chainId: Number(Registry.chainId),
    blockNumber: BOOTSTRAP_TEST_OBSERVATION.blockNumber,
};
const unsupported = () =>
    new ContractFunctionRevertedError({ abi: [], functionName: F.NextProject });
const project = {
    [F.Registered]: false,
    [F.NextProject]: 1n,
    [F.Details]: ["Project", "Artist", "", "", ""],
    [F.State]: [0n, 1000n],
};
function fixture(values: Record<string, unknown> = {}) {
    const calls: Read[] = [],
        output: BootstrapOutput[] = [];
    const rpc: Pick<BootstrapProbeRpc, "readContract"> = {
        async readContract<T>(params: Read): Promise<T> {
            calls.push(params);
            if (!(params.functionName in values)) throw unsupported();
            const value = values[params.functionName];
            if (value instanceof Error) throw value;
            return value as T;
        },
    };
    return {
        calls,
        output,
        probe: (overrides: Partial<typeof input> = {}) =>
            probeArtBlocksSharedContract(
                rpc,
                { ...input, ...overrides },
                (event) => output.push(event),
            ),
        inspect: (
            tokenId = "163000485",
            overrides: Partial<typeof input> = {},
        ) =>
            inspectArtBlocksProjectScope(
                rpc,
                { ...input, ...overrides, tokenId },
                (event) => output.push(event),
            ),
    };
}
describe("advisory on-chain shared-contract recognition", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("stops an empty nextProjectId response through production RPC retry and viem decoding", async () => {
        const selectors: string[] = [];
        const registrySelector = getFunctionSelector(
            `${F.Registered}(address)`,
        );
        vi.stubGlobal(
            "fetch",
            vi.fn(async (_url, init) => {
                const request = JSON.parse(String(init?.body));
                const selector = request.params[0].data.slice(0, 10);
                selectors.push(selector);
                return new Response(
                    JSON.stringify({
                        jsonrpc: "2.0",
                        id: request.id,
                        result:
                            selector === registrySelector
                                ? encodeAbiParameters(
                                      parseAbiParameters("bool"),
                                      [false],
                                  )
                                : "0x",
                    }),
                    { headers: { "content-type": "application/json" } },
                );
            }),
        );
        const sleep = vi.fn(async () => {});
        const rpc = new ViemBackendRpcClient(
            [{ url: "https://rpc.example", weight: 1 }],
            NOOP_APM,
            undefined,
            {
                retryPolicy: getDefaultRpcRetryPolicy(),
                resilience: {
                    ...getDefaultRpcEndpointResilienceConfig(),
                    rateLimiter: { requestsPerSecond: 0, burst: 1 },
                },
                sleep,
            },
        );
        const output: BootstrapOutput[] = [];
        expect(
            await probeArtBlocksSharedContract(rpc, input, (event) =>
                output.push(event),
            ),
        ).toBeNull();
        expect(selectors).toEqual([
            registrySelector,
            getFunctionSelector(`${F.NextProject}()`),
        ]);
        expect(sleep).not.toHaveBeenCalled();
        expect(output.at(-1)).toMatchObject({ status: Status.Skipped });
    });

    it("recognizes registered multi-project contracts without scanning their inventory", async () => {
        const f = fixture({ [F.Registered]: true });
        expect(await f.probe()).toEqual({
            reason: Reason.Registry,
            registryAddress: Registry.address,
        });
        expect(f.calls).toHaveLength(1);
        expect(f.calls[0]).toMatchObject({
            address: Registry.address,
            args: [input.address],
            blockNumber: input.blockNumber,
        });
    });
    it("recognizes the project model even with only one unminted project, without OpenSea or metadata", async () => {
        const fetch = vi.spyOn(globalThis, "fetch");
        try {
            const f = fixture(project);
            expect(await f.probe()).toEqual({
                reason: Reason.ProjectInterface,
                registryAddress: null,
            });
            expect(f.calls.map((c) => c.functionName)).toEqual([
                F.Registered,
                F.NextProject,
                F.Details,
                F.State,
            ]);
            expect(
                f.calls
                    .filter((c) => c.functionName !== F.Registered)
                    .every(
                        (c) =>
                            c.address === input.address &&
                            c.blockNumber === input.blockNumber,
                    ),
            ).toBe(true);
            expect(fetch).not.toHaveBeenCalled();
        } finally {
            fetch.mockRestore();
        }
    });
    it("recognizes legacy compatible forks through the counter prefix and never assumes project zero", async () => {
        const f = fixture({
            ...project,
            [F.NextProject]: 164n,
            [F.State]: unsupported(),
            [F.TokenInfo]: [BOOTSTRAP_TEST_OWNER, 0n, 1000n, 1000n],
        });
        expect(await f.probe()).toMatchObject({
            reason: Reason.ProjectInterface,
        });
        const projectGetters = new Set<string>([
            F.Details,
            F.State,
            F.TokenInfo,
        ]);
        expect(
            f.calls
                .filter((c) => projectGetters.has(c.functionName))
                .every((c) => c.args?.[0] === 163n),
        ).toBe(true);
        expect(f.calls).toHaveLength(5);
    });
    it("never uses the mainnet registry on another chain", async () => {
        const f = fixture(project);
        expect(await f.probe({ chainId: 10 })).toMatchObject({
            reason: Reason.ProjectInterface,
        });
        expect(f.calls.some((c) => c.address === Registry.address)).toBe(false);
    });
    for (const values of [
        {},
        { [F.Registered]: "true" },
        { [F.NextProject]: 0n },
        { [F.NextProject]: -1n },
        { [F.NextProject]: 1n },
        { ...project, [F.Details]: ["", "", "", "", ""] },
        { ...project, [F.Details]: ["Project"] },
        { ...project, [F.State]: [1001n, 1000n] },
        { ...project, [F.State]: [0n, 0n] },
        { ...project, [F.State]: ["1", "1000"] },
    ]) {
        it(`leaves insufficient/inconsistent evidence unknown (${Object.keys(values).join(",") || "unsupported"})`, async () => {
            expect(await fixture(values).probe()).toBeNull();
        });
    }
    it("treats missing getters as unsupported and RPC failure as unavailable, without rejecting setup", async () => {
        const unsupportedFixture = fixture();
        expect(await unsupportedFixture.probe()).toBeNull();
        expect(
            unsupportedFixture.output.filter(
                (e) => e.status === Status.Skipped,
            ),
        ).toHaveLength(2);
        const failure = fixture({
            [F.Registered]: new Error("RPC offline"),
            [F.NextProject]: new Error("RPC offline"),
        });
        expect(await failure.probe()).toBeNull();
        expect(
            failure.output.filter((e) => e.status === Status.Failed),
        ).toHaveLength(2);
        expect(
            await fixture({
                ...project,
                [F.Registered]: new Error("Registry unavailable"),
            }).probe(),
        ).toMatchObject({ reason: Reason.ProjectInterface });
    });

    it("reports a provider state error wrapped as a revert as a failed check", async () => {
        const stateError = new ContractFunctionRevertedError({
            abi: [],
            functionName: F.NextProject,
            message: "historical state is not available",
        });
        const f = fixture({
            [F.Registered]: false,
            [F.NextProject]: stateError,
        });
        expect(await f.probe()).toBeNull();
        expect(f.output.at(-1)).toMatchObject({ status: Status.Failed });
    });
});

const legacyProject = {
    [F.Registered]: true,
    [F.TokenProject]: 163n,
    [F.TokenInfo]: [BOOTSTRAP_TEST_OWNER, 0n, 1000n, 1000n],
    [F.Details]: ["Meridian", "Matt DesLauriers", "", "", ""],
};
describe("Art Blocks sample project range suggestions", () => {
    it("uses the sampled legacy project, with pinned reads and no global supply or project scan", async () => {
        const f = fixture(legacyProject);
        expect(await f.inspect()).toEqual({
            projectId: "163",
            projectName: "Meridian",
            startTokenId: "163000000",
            mintedTokenCount: 1000,
            maxTokenCount: 1000,
        });
        expect(f.calls.map((call) => call.functionName)).toEqual([
            F.Registered,
            F.CoreType,
            F.TokenProject,
            F.TokenInfo,
            F.Details,
        ]);
        expect(
            f.calls.every((call) => call.blockNumber === input.blockNumber),
        ).toBe(true);
        expect(
            f.calls.find((call) => call.functionName === F.TokenInfo)?.args,
        ).toEqual([163n]);
    });
    for (const coreType of ART_BLOCKS_V3_CORE_TYPES) {
        it(`reads a registered ${coreType} project and separates minted count from maximum`, async () => {
            const f = fixture({
                [F.Registered]: true,
                [F.CoreType]: coreType,
                [F.State]: [486n, 1000n],
            });
            expect(await f.inspect()).toEqual({
                projectId: "163",
                projectName: null,
                startTokenId: "163000000",
                mintedTokenCount: 486,
                maxTokenCount: 1000,
            });
        });
    }
    it("reads V3 state counters even when tokenIdToProjectId is present, as on live Engine cores", async () => {
        const f = fixture({
            ...legacyProject,
            [F.TokenProject]: 0n,
            [F.CoreType]: ART_BLOCKS_V3_CORE_TYPES[1],
            [F.State]: [441n, 500n],
        });
        expect(await f.inspect("0")).toMatchObject({
            projectId: "0",
            startTokenId: "0",
            mintedTokenCount: 441,
            maxTokenCount: 500,
        });
        expect(f.calls.some((call) => call.functionName === F.TokenInfo)).toBe(
            false,
        );
    });
    it("supports project zero and large project IDs without numeric precision loss", async () => {
        for (const id of [0n, 9007199254740993n]) {
            expect(
                await fixture({
                    ...legacyProject,
                    [F.TokenProject]: id,
                }).inspect(String(id * STRIDE + 1n)),
            ).toMatchObject({
                projectId: String(id),
                startTokenId: String(id * STRIDE),
            });
        }
    });
    it("never treats compatible unregistered forks or another chain as recognized Art Blocks", async () => {
        const f = fixture({ ...legacyProject, [F.Registered]: false });
        expect(await f.inspect()).toBeNull();
        expect(f.calls).toHaveLength(1);
        const otherChain = fixture(legacyProject);
        expect(await otherChain.inspect(undefined, { chainId: 10 })).toBeNull();
        expect(otherChain.calls).toHaveLength(0);
    });
    for (const [name, values] of Object.entries({
        "registry failure": { [F.Registered]: new Error("offline") },
        "core identity transport failure": {
            [F.CoreType]: new Error("offline"),
        },
        "mapping mismatch": { [F.TokenProject]: 162n },
        "malformed mapping": { [F.TokenProject]: "163" },
        "mapping transport failure": {
            [F.TokenProject]: new Error("offline"),
            [F.CoreType]: ART_BLOCKS_V3_CORE_TYPES[0],
            [F.State]: [1000n, 1000n],
        },
        "counts unavailable": { [F.TokenInfo]: new Error("offline") },
        "minted exceeds maximum": {
            [F.TokenInfo]: [BOOTSTRAP_TEST_OWNER, 0n, 1001n, 1000n],
        },
        "zero invocations": {
            [F.TokenInfo]: [BOOTSTRAP_TEST_OWNER, 0n, 0n, 1000n],
        },
        "sample beyond minted span": {
            [F.TokenInfo]: [BOOTSTRAP_TEST_OWNER, 0n, 485n, 1000n],
        },
        "maximum exceeds namespace": {
            [F.TokenInfo]: [BOOTSTRAP_TEST_OWNER, 0n, 1000n, STRIDE + 1n],
        },
        "negative counts": {
            [F.TokenInfo]: [BOOTSTRAP_TEST_OWNER, 0n, -1n, 1000n],
        },
        "malformed counts": {
            [F.TokenInfo]: [BOOTSTRAP_TEST_OWNER, 0n, "1000", "1000"],
        },
        "unknown v3 model": {
            [F.TokenProject]: unsupported(),
            [F.CoreType]: "future core",
            [F.State]: [1000n, 1000n],
        },
    })) {
        it(`withholds suggestions on ${name}`, async () => {
            const f = fixture({ ...legacyProject, ...values });
            expect(await f.inspect()).toBeNull();
            if (name === "mapping transport failure")
                expect(
                    f.calls.some((call) => call.functionName === F.State),
                ).toBe(false);
        });
    }
    it("rejects a suggested maximum outside uint256 even when the sample fits", async () => {
        const projectId = EVM_TOKEN_ID_MAX / STRIDE;
        const f = fixture({
            ...legacyProject,
            [F.TokenProject]: projectId,
            [F.TokenInfo]: [BOOTSTRAP_TEST_OWNER, 0n, STRIDE, STRIDE],
        });
        expect(await f.inspect(String(EVM_TOKEN_ID_MAX))).toBeNull();
    });
    it("keeps valid range facts when the optional project name fails", async () => {
        expect(
            await fixture({
                ...legacyProject,
                [F.Details]: new Error("offline"),
            }).inspect(),
        ).toMatchObject({ projectName: null, mintedTokenCount: 1000 });
    });
});
