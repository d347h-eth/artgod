import { describe, expect, it, vi } from "vitest";
import { ContractFunctionRevertedError } from "viem";
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
} from "./art-blocks.js";

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
    };
}
describe("advisory on-chain shared-contract recognition", () => {
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
});
