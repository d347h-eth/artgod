import { describe, expect, it, vi } from "vitest";
import {
    ContractFunctionRevertedError,
    encodeErrorResult,
    zeroAddress,
} from "viem";
import {
    ERC721_OWNERSHIP_ABI,
    ERC721_OWNER_OF_FUNCTION,
    ERC721_ABSENT_TOKEN_ERROR,
} from "@artgod/shared/evm/erc721-ownership";
import { Erc721TokenOwnership } from "../src/infra/bootstrap/erc721-token-ownership.js";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const SAMPLE = "2";
const ANCHOR = 123456;

describe("anchored token ownership", () => {
    it("reads the exact token at the pinned block", async () => {
        const rpc = { readContract: vi.fn().mockResolvedValue(OWNER) };
        await expect(
            new Erc721TokenOwnership(rpc).readOwner(ADDRESS, SAMPLE, ANCHOR),
        ).resolves.toBe(OWNER);
        expect(rpc.readContract).toHaveBeenCalledExactlyOnceWith({
            address: ADDRESS,
            abi: ERC721_OWNERSHIP_ABI,
            functionName: ERC721_OWNER_OF_FUNCTION,
            args: [2n],
            blockNumber: ANCHOR,
        });
    });

    it("skips a decoded nonexistent-token revert", async () => {
        const revert = new ContractFunctionRevertedError({
            abi: ERC721_OWNERSHIP_ABI,
            functionName: ERC721_OWNER_OF_FUNCTION,
            data: encodeErrorResult({
                abi: ERC721_OWNERSHIP_ABI,
                errorName: ERC721_ABSENT_TOKEN_ERROR.NonexistentToken,
                args: [2n],
            }),
        });
        const rpc = {
            readContract: vi
                .fn()
                .mockRejectedValue(new Error("call failed", { cause: revert })),
        };
        await expect(
            new Erc721TokenOwnership(rpc).readOwner(ADDRESS, SAMPLE, ANCHOR),
        ).resolves.toBeNull();
    });

    it("skips the legacy decoded owner-query error", async () => {
        const revert = new ContractFunctionRevertedError({
            abi: ERC721_OWNERSHIP_ABI,
            functionName: ERC721_OWNER_OF_FUNCTION,
            message: ERC721_ABSENT_TOKEN_ERROR.LegacyOwnerQuery,
        });
        const rpc = { readContract: vi.fn().mockRejectedValue(revert) };
        await expect(
            new Erc721TokenOwnership(rpc).readOwner(ADDRESS, SAMPLE, ANCHOR),
        ).resolves.toBeNull();
    });

    it.each([
        "RPC timeout",
        "execution reverted",
        "missing revert data",
        "historical state is not available",
    ])("keeps uncertain reads as failures (%s)", async (message) => {
        const failure = new Error(message);
        const rpc = { readContract: vi.fn().mockRejectedValue(failure) };
        await expect(
            new Erc721TokenOwnership(rpc).readOwner(ADDRESS, SAMPLE, ANCHOR),
        ).rejects.toBe(failure);
    });

    it.each([zeroAddress, "0x", "invalid"])(
        "rejects invalid ownership (%s)",
        async (owner) => {
            const rpc = { readContract: vi.fn().mockResolvedValue(owner) };
            await expect(
                new Erc721TokenOwnership(rpc).readOwner(
                    ADDRESS,
                    SAMPLE,
                    ANCHOR,
                ),
            ).rejects.toThrow();
        },
    );
});
