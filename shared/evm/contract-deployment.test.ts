import { describe, expect, it } from "vitest";
import {
    findContractDeploymentBlock,
    type ContractDeploymentSearchProgress,
} from "./contract-deployment.js";

const ADDRESS = "0x0000000000000000000000000000000000000001";

function search(deployment: number, upperBlock: number) {
    return findContractDeploymentBlock({
        address: ADDRESS,
        upperBlock,
        rpc: {
            getBytecode: async (_address, block) =>
                block >= deployment ? "0x00" : null,
        },
    });
}

describe("contract deployment search", () => {
    it("finds every boundary in the full range, including genesis and the upper block", async () => {
        for (let upper = 0; upper < 80; upper += 1) {
            for (let deployment = 0; deployment <= upper; deployment += 1) {
                expect(await search(deployment, upper)).toBe(deployment);
            }
        }
    });

    it("fails when code is absent at the upper block", async () => {
        await expect(search(101, 100)).rejects.toThrow("no code");
    });

    it("propagates unavailable archive state", async () => {
        const failure = new Error("historical state unavailable");
        await expect(
            findContractDeploymentBlock({
                address: ADDRESS,
                upperBlock: 100,
                rpc: {
                    getBytecode: async () => {
                        throw failure;
                    },
                },
            }),
        ).rejects.toBe(failure);
    });

    it("resumes every saved probe without repeating successful code reads", async () => {
        for (const deployment of [0, 1, 42, 100]) {
            const successful: number[] = [];
            let saved: ContractDeploymentSearchProgress | undefined;
            let result: number | undefined;
            for (
                let attempt = 0;
                attempt < 20 && result === undefined;
                attempt++
            ) {
                let granted = false;
                try {
                    result = await findContractDeploymentBlock({
                        address: ADDRESS,
                        upperBlock: 100,
                        progress: saved,
                        onProgress: (progress) => {
                            saved = progress;
                        },
                        rpc: {
                            getBytecode: async (_address, block) => {
                                if (granted)
                                    throw new Error("capacity unavailable");
                                granted = true;
                                successful.push(block);
                                return block >= deployment ? "0x00" : null;
                            },
                        },
                    });
                } catch (error) {
                    expect((error as Error).message).toBe(
                        "capacity unavailable",
                    );
                }
            }
            expect(result).toBe(deployment);
            expect(new Set(successful).size).toBe(successful.length);
        }
    });

    it("does not continue after the caller fails to save a successful probe", async () => {
        const failure = new Error("storage unavailable");
        const blocks: number[] = [];
        await expect(
            findContractDeploymentBlock({
                address: ADDRESS,
                upperBlock: 100,
                rpc: {
                    getBytecode: async (_address, block) => {
                        blocks.push(block);
                        return "0x00";
                    },
                },
                onProgress: () => {
                    throw failure;
                },
            }),
        ).rejects.toBe(failure);
        expect(blocks).toEqual([100]);
    });

    it.each([
        { absentBlock: -2, presentBlock: 100 },
        { absentBlock: 0, presentBlock: null },
        { absentBlock: 42, presentBlock: 42 },
        { absentBlock: -1, presentBlock: 101 },
        { absentBlock: 1.5, presentBlock: 42 },
    ])("rejects invalid saved search boundaries: %j", async (progress) => {
        await expect(
            findContractDeploymentBlock({
                address: ADDRESS,
                upperBlock: 100,
                progress,
                rpc: {
                    getBytecode: async () => {
                        throw new Error("Unexpected request");
                    },
                },
            }),
        ).rejects.toThrow("Invalid contract deployment search progress");
    });

    it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN])(
        "rejects an invalid upper block: %s",
        async (upperBlock) => {
            await expect(search(1, upperBlock)).rejects.toThrow("Invalid");
        },
    );
});
