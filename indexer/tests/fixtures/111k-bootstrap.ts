import { encodeEventTopics, zeroAddress } from "viem";
import type { CollectionExtensionInstall } from "@artgod/shared/extensions";
import { resolveEmbeddedCollectionExtensionInstallByKey } from "@artgod/shared/extensions/built-ins";
import {
    NFT111K_EXTENSION_KEY,
    NFT111K_MAINNET_CHAIN_ID,
    NFT111K_MAINNET_CONTRACT_ADDRESS,
    NFT111K_MAINNET_DEPLOYMENT_BLOCK,
} from "@artgod/shared/extensions/111k";
import { ERC721_ABI, ERC721_EVENT_NAME } from "../../src/abi/index.js";
import type { Hex, RpcLog } from "../../src/ports/rpc.js";

export const NFT111K_TEST_OWNER = "0x1234567890123456789012345678901234567890";
export const NFT111K_TEST_ANCHOR = {
    chainId: NFT111K_MAINNET_CHAIN_ID,
    blockNumber: NFT111K_MAINNET_DEPLOYMENT_BLOCK + 20,
    blockHash: "0x" + "ab".repeat(32),
};
export function nft111kTestInstall(): CollectionExtensionInstall {
    return {
        ...resolveEmbeddedCollectionExtensionInstallByKey({
            chainId: NFT111K_MAINNET_CHAIN_ID,
            extensionKey: NFT111K_EXTENSION_KEY,
        })!,
        chainId: NFT111K_MAINNET_CHAIN_ID,
        collectionId: 7,
        enabled: true,
        createdAt: "",
        updatedAt: "",
    };
}

/** Synthetic Transfer fixture. Real captured history lives in its separate fixture. */
export function nft111kTestMint(
    tokenId: string,
    overrides: Partial<RpcLog> = {},
): RpcLog {
    return {
        address: NFT111K_MAINNET_CONTRACT_ADDRESS as Hex,
        blockNumber: NFT111K_MAINNET_DEPLOYMENT_BLOCK,
        blockHash: NFT111K_TEST_ANCHOR.blockHash as Hex,
        transactionHash: ("0x" + "cd".repeat(32)) as Hex,
        logIndex: 0,
        data: "0x",
        topics: encodeEventTopics({
            abi: ERC721_ABI,
            eventName: ERC721_EVENT_NAME.Transfer,
            args: {
                from: zeroAddress,
                to: NFT111K_TEST_OWNER,
                tokenId: BigInt(tokenId),
            },
        }) as Hex[],
        ...overrides,
    };
}
