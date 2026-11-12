import { describe, expect, it, vi } from "vitest";
import { zeroAddress } from "viem";
import {
    NFT111K_EXTENSION_KEY,
    NFT111K_MAINNET_CHAIN_ID,
    NFT111K_MAINNET_CONTRACT_ADDRESS,
    NFT111K_MAINNET_DEPLOYMENT_BLOCK,
} from "@artgod/shared/extensions/111k";
import {
    NFT111K_BOOTSTRAP_ABI,
    NFT111K_ITEM_KIND as Kind,
    NFT111K_MINT_LOG_PAGE_BLOCKS,
    NFT111K_READ_FUNCTION as Read,
    NFT111K_TOKEN_INFO_BATCH_LIMIT,
    nft111kIndexerExtension,
} from "../src/application/collection-extensions/111k.js";
import type { CollectionExtensionBootstrapEnumerationContext as Context } from "../src/application/collection-extensions/types.js";
import type { RpcProviderPort } from "../src/ports/rpc.js";
import { ERC721_ABI } from "../src/abi/index.js";
import {
    NFT111K_TEST_ANCHOR,
    NFT111K_TEST_OWNER,
    nft111kTestInstall,
    nft111kTestMint,
} from "./fixtures/111k-bootstrap.js";

function fixture(
    ids = ["1000001", "111891", "1", "2", "111891"],
    absent = new Set(["2"]),
) {
    const logs = ids.map((id) => nft111kTestMint(id));
    const supply = BigInt(new Set(ids.filter((id) => !absent.has(id))).size);
    const readContractAtBlock = vi.fn(
        async (
            input: Parameters<RpcProviderPort["readContractAtBlock"]>[0],
        ): Promise<unknown> => {
            if (input.functionName === Read.TotalSupply) return supply;
            expect(input.functionName).toBe(Read.GetTokenInfos);
            return (input.args![0] as bigint[]).map((id) =>
                absent.has(id.toString())
                    ? {
                          kind: Kind.None,
                          displayId: 0n,
                          holder: zeroAddress,
                      }
                    : {
                          kind:
                              id > 1_000_000n
                                  ? Kind.ArtworkReceipt
                                  : Kind.Artwork,
                          displayId: id,
                          holder: NFT111K_TEST_OWNER,
                      },
            );
        },
    );
    const rpc = {
        getBlock: vi.fn(async (blockNumber: number) => ({
            number: blockNumber,
            hash: NFT111K_TEST_ANCHOR.blockHash as `0x${string}`,
            parentHash: "0x00" as const,
            timestamp: 1,
            transactions: [],
        })),
        getLogs: vi.fn(
            async (filter: Parameters<RpcProviderPort["getLogs"]>[0]) =>
                logs.filter(
                    (log) =>
                        log.blockNumber >= filter.fromBlock &&
                        log.blockNumber <= filter.toBlock,
                ),
        ),
        readContractAtBlock: <T>(
            input: Parameters<RpcProviderPort["readContractAtBlock"]>[0],
        ): Promise<T> => readContractAtBlock(input) as Promise<T>,
    };
    const context: Context = {
        rpc,
        install: nft111kTestInstall(),
        contract: NFT111K_MAINNET_CONTRACT_ADDRESS,
        anchor: { ...NFT111K_TEST_ANCHOR },
        onProgress: vi.fn(),
    };
    return {
        rpc,
        readContractAtBlock,
        context,
        logs,
        enumerate: () =>
            nft111kIndexerExtension.enumerateBootstrapTokenIds!(context),
    };
}

describe("111K anchored bootstrap inventory", () => {
    it("deduplicates sparse mint IDs, filters burns and includes receipts without Enumerable reads", async () => {
        const f = fixture();
        expect(await f.enumerate()).toEqual(["1", "111891", "1000001"]);
        expect(f.rpc.getLogs).toHaveBeenCalledExactlyOnceWith({
            address: NFT111K_MAINNET_CONTRACT_ADDRESS,
            event: ERC721_ABI[0],
            args: { from: zeroAddress },
            fromBlock: NFT111K_MAINNET_DEPLOYMENT_BLOCK,
            toBlock: NFT111K_TEST_ANCHOR.blockNumber,
        });
        expect(
            f.readContractAtBlock.mock.calls.map(
                ([input]) => input.functionName,
            ),
        ).toEqual([Read.TotalSupply, Read.GetTokenInfos, Read.TotalSupply]);
        for (const [input] of f.readContractAtBlock.mock.calls) {
            expect(input.block).toEqual(f.context.anchor);
            expect(input.abi).toBe(NFT111K_BOOTSTRAP_ABI);
        }
        expect(f.readContractAtBlock.mock.calls[1][0].args).toEqual([
            [1n, 2n, 111891n, 1000001n],
        ]);
        expect(f.rpc.getBlock).toHaveBeenCalledTimes(2);
        expect(f.rpc.getBlock).toHaveBeenLastCalledWith(
            f.context.anchor.blockNumber,
            { fresh: true },
        );
        expect(
            vi.mocked(f.context.onProgress).mock.calls.map(([p]) => p),
        ).toEqual([
            { resolved: 0, total: null },
            { resolved: 0, total: 4 },
            { resolved: 4, total: 4 },
        ]);
    });

    it("includes deployment and anchor boundaries in bounded pages, with no request for post-anchor mints", async () => {
        const f = fixture(["1", "2", "3"], new Set());
        f.context.anchor.blockNumber =
            NFT111K_MAINNET_DEPLOYMENT_BLOCK + NFT111K_MINT_LOG_PAGE_BLOCKS * 2;
        f.logs[1].blockNumber =
            NFT111K_MAINNET_DEPLOYMENT_BLOCK + NFT111K_MINT_LOG_PAGE_BLOCKS;
        f.logs[2].blockNumber = f.context.anchor.blockNumber;
        f.logs.push(
            nft111kTestMint("3000001", {
                blockNumber: f.context.anchor.blockNumber + 1,
            }),
        );
        expect(await f.enumerate()).toEqual(["1", "2", "3"]);
        expect(
            f.rpc.getLogs.mock.calls.map(([p]) => [p.fromBlock, p.toBlock]),
        ).toEqual([
            [
                NFT111K_MAINNET_DEPLOYMENT_BLOCK,
                NFT111K_MAINNET_DEPLOYMENT_BLOCK +
                    NFT111K_MINT_LOG_PAGE_BLOCKS -
                    1,
            ],
            [
                NFT111K_MAINNET_DEPLOYMENT_BLOCK + NFT111K_MINT_LOG_PAGE_BLOCKS,
                f.context.anchor.blockNumber - 1,
            ],
            [f.context.anchor.blockNumber, f.context.anchor.blockNumber],
        ]);
    });

    it("checks 151 candidates in positional batches of 150 and 1", async () => {
        const count = NFT111K_TOKEN_INFO_BATCH_LIMIT + 1;
        const f = fixture(
            Array.from({ length: count }, (_, i) => String(count - i)),
            new Set(["150"]),
        );
        const result = await f.enumerate();
        expect(result).toEqual(
            Array.from({ length: count }, (_, i) => String(i + 1)).filter(
                (id) => id !== "150",
            ),
        );
        expect(
            f.readContractAtBlock.mock.calls
                .filter(([p]) => p.functionName === Read.GetTokenInfos)
                .map(([p]) => (p.args![0] as bigint[]).length),
        ).toEqual([150, 1]);
        expect(f.context.onProgress).toHaveBeenLastCalledWith({
            resolved: count,
            total: count,
        });
    });

    it.each([
        { kind: Kind.None, displayId: 0n, holder: NFT111K_TEST_OWNER },
        { kind: Kind.None, displayId: 1n, holder: zeroAddress },
        { kind: Kind.Artwork, displayId: 1n, holder: zeroAddress },
        { kind: Kind.Artwork, displayId: 1n, holder: "bad" },
        { kind: Kind.Artwork, displayId: 0n, holder: NFT111K_TEST_OWNER },
        { kind: Kind.Artwork, displayId: -1n, holder: NFT111K_TEST_OWNER },
        { kind: 8, displayId: 1n, holder: NFT111K_TEST_OWNER },
        { kind: "1", displayId: 1n, holder: NFT111K_TEST_OWNER },
        { kind: Kind.Artwork, displayId: "1", holder: NFT111K_TEST_OWNER },
        null,
    ])("rejects malformed or inconsistent token info: %o", async (info) => {
        const f = fixture(["1"]);
        f.readContractAtBlock
            .mockResolvedValueOnce(1n)
            .mockResolvedValueOnce([info]);
        await expect(f.enumerate()).rejects.toThrow();
    });

    it.each([[], [null, null], null])(
        "rejects a malformed batch result: %o",
        async (infos) => {
            const f = fixture(["1"]);
            f.readContractAtBlock
                .mockResolvedValueOnce(1n)
                .mockResolvedValueOnce(infos);
            await expect(f.enumerate()).rejects.toThrow("result count");
        },
    );

    it.each(["history", "state", "checksum"])(
        "propagates a %s RPC failure without treating it as absence",
        async (where) => {
            const f = fixture(["1"]);
            const error = new Error("historical state unavailable");
            if (where === "history") f.rpc.getLogs.mockRejectedValue(error);
            else if (where === "state")
                f.readContractAtBlock
                    .mockResolvedValueOnce(1n)
                    .mockRejectedValueOnce(error);
            else f.readContractAtBlock.mockRejectedValue(error);
            await expect(f.enumerate()).rejects.toBe(error);
        },
    );

    it.each([0n, 2n, "1", -1n])(
        "rejects invalid or incomplete anchored supply %s",
        async (supply) => {
            const f = fixture(["1"]);
            f.readContractAtBlock.mockResolvedValueOnce(supply);
            await expect(f.enumerate()).rejects.toThrow();
        },
    );

    it("rechecks the exact supply and fresh header before accepting inventory", async () => {
        const f = fixture(["1"]);
        f.readContractAtBlock
            .mockResolvedValueOnce(1n)
            .mockResolvedValueOnce([
                {
                    kind: Kind.Artwork,
                    displayId: 1n,
                    holder: NFT111K_TEST_OWNER,
                },
            ])
            .mockResolvedValueOnce(2n);
        await expect(f.enumerate()).rejects.toThrow(
            "does not match totalSupply",
        );
        const changed = fixture(["1"]);
        changed.rpc.getBlock
            .mockResolvedValueOnce(
                await changed.rpc.getBlock(NFT111K_TEST_ANCHOR.blockNumber),
            )
            .mockResolvedValueOnce({
                number: NFT111K_TEST_ANCHOR.blockNumber,
                hash: `0x${"ff".repeat(32)}`,
                parentHash: "0x00",
                timestamp: 1,
                transactions: [],
            });
        await expect(changed.enumerate()).rejects.toThrow("anchor changed");
    });

    it.each([
        { address: zeroAddress },
        { blockNumber: NFT111K_MAINNET_DEPLOYMENT_BLOCK - 1 },
        { blockNumber: NFT111K_TEST_ANCHOR.blockNumber + 1 },
        { topics: [] },
        { data: "0x1234" as const, topics: [] },
    ])("fails on an invalid selected mint log: %o", async (overrides) => {
        const f = fixture(["1"]);
        f.rpc.getLogs.mockResolvedValue([nft111kTestMint("1", overrides)]);
        await expect(f.enumerate()).rejects.toThrow("Invalid selected");
    });

    it("rejects an ordinary transfer returned by a supposedly mint-only query", async () => {
        const f = fixture(["1"]);
        const log = nft111kTestMint("1");
        log.topics[1] = log.topics[2];
        f.rpc.getLogs.mockResolvedValue([log]);
        await expect(f.enumerate()).rejects.toThrow("Invalid selected");
    });

    it.each(["", "0x1234", null])(
        "requires an exact anchor hash: %s",
        async (blockHash) => {
            const f = fixture();
            f.context.anchor.blockHash = blockHash as string;
            await expect(f.enumerate()).rejects.toThrow("anchor");
            expect(f.rpc.getLogs).not.toHaveBeenCalled();
        },
    );

    it("rejects a pre-deployment anchor and a mismatched fresh header", async () => {
        const f = fixture();
        f.context.anchor.blockNumber = NFT111K_MAINNET_DEPLOYMENT_BLOCK - 1;
        await expect(f.enumerate()).rejects.toThrow("anchor");
        const changed = fixture();
        changed.rpc.getBlock.mockResolvedValue({
            number: NFT111K_TEST_ANCHOR.blockNumber + 1,
            hash: NFT111K_TEST_ANCHOR.blockHash as `0x${string}`,
            parentHash: "0x00",
            timestamp: 1,
            transactions: [],
        });
        await expect(changed.enumerate()).rejects.toThrow("anchor changed");
    });

    it.each([
        { enabled: false },
        { extensionKey: "unknown" },
        { chainId: 10 },
        { configJson: "{}" },
        { configJson: "null" },
        { configJson: "bad" },
        {
            configJson: JSON.stringify({
                mainContractAddress: zeroAddress,
                deploymentBlock: NFT111K_MAINNET_DEPLOYMENT_BLOCK,
            }),
        },
        {
            configJson: JSON.stringify({
                mainContractAddress: NFT111K_MAINNET_CONTRACT_ADDRESS,
                deploymentBlock: NFT111K_MAINNET_DEPLOYMENT_BLOCK + 1,
            }),
        },
    ])("rejects a changed install: %o", async (overrides) => {
        const f = fixture();
        Object.assign(f.context.install, overrides);
        await expect(f.enumerate()).rejects.toThrow();
        expect(f.rpc.getBlock).not.toHaveBeenCalled();
    });
    it("rejects another context identity and retains the empty-inventory restriction", async () => {
        const f = fixture();
        f.context.contract = zeroAddress;
        await expect(f.enumerate()).rejects.toThrow("deployment");
        f.context.contract = NFT111K_MAINNET_CONTRACT_ADDRESS;
        f.context.anchor.chainId = 10;
        await expect(f.enumerate()).rejects.toThrow("deployment");
        await expect(fixture([], new Set()).enumerate()).rejects.toThrow(
            "No tokens exist",
        );
    });
});
