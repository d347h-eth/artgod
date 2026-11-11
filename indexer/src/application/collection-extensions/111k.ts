import { parseAbi, zeroAddress } from "viem";
import {
    NFT111K_EXTENSION_KEY,
    NFT111K_MAINNET_CHAIN_ID,
    NFT111K_MAINNET_CONTRACT_ADDRESS,
    NFT111K_MAINNET_DEPLOYMENT_BLOCK,
} from "@artgod/shared/extensions/111k";
import { normalizeAddressRef } from "@artgod/shared/utils/ref-resolver";
import { normalizeErc721Owner } from "@artgod/shared/evm/erc721-ownership";
import { normalizeEvmTokenId } from "@artgod/shared/evm/token-id";
import { ERC721_ABI } from "../../abi/index.js";
import { ChainSyncConflict } from "../../domain/chain-sync.js";
import { COLLECTION_STANDARD } from "../../domain/collections.js";
import type { Hex } from "../../ports/rpc.js";
import type { TokenMetadata } from "../../domain/metadata.js";
import type { MetadataTarget } from "../../domain/metadata-pending.js";
import { decodeNftTransferLog } from "../nft-transfers.js";
import type {
    CollectionExtensionBootstrapEnumerationContext,
    IndexerCollectionExtension,
} from "./types.js";

export const NFT111K_READ_FUNCTION = {
    TotalSupply: "totalSupply",
    GetTokenInfos: "getTokenInfos",
} as const;
export const NFT111K_BOOTSTRAP_ABI = parseAbi([
    `function ${NFT111K_READ_FUNCTION.TotalSupply}() view returns (uint256)`,
    `function ${NFT111K_READ_FUNCTION.GetTokenInfos}(uint256[] tokenIds) view returns ((uint8 kind, uint256 displayId, address holder)[] infos)`,
]);
export const NFT111K_ITEM_KIND = {
    None: 0,
    Artwork: 1,
    Crate: 2,
    Warehouse: 3,
    ArtworkReceipt: 4,
    CrateReceipt: 5,
    Relic: 6,
    RelicReceipt: 7,
} as const;
export const NFT111K_TOKEN_INFO_BATCH_LIMIT = 150;
// Bound each response; the RPC adapter may split this further for its endpoint pool.
export const NFT111K_MINT_LOG_PAGE_BLOCKS = 2_000;
const ITEM_KINDS = new Set<number>(Object.values(NFT111K_ITEM_KIND));

// Fixed by the deployed contract's getTokenInfo; receipts have separate ID ranges.
export const NFT111K_TOKEN_RANGES = {
    Artwork: { first: 1n, last: 111_111n },
    Crate: { first: 111_112n, last: 116_666n },
    Warehouse: { first: 116_667n, last: 117_171n },
    Relic: { first: 117_172n, last: 117_189n },
} as const;
const CONTAINER_TOKEN_RANGES = [
    NFT111K_TOKEN_RANGES.Crate,
    NFT111K_TOKEN_RANGES.Warehouse,
    NFT111K_TOKEN_RANGES.Relic,
];

export const NFT111K_METADATA = {
    Category: "category",
    CollectionBlock: "collection block",
    Egg: "egg",
    PlaceholderImage: "https://cdn.lil.org/nft/111k/placeholder.png",
    RevealStatus: "revealStatus",
    Revealed: "revealed",
} as const;

export function isNft111kMetadataReady(
    target: MetadataTarget,
    metadata: TokenMetadata,
): boolean {
    const image = metadata.image?.trim().split(/[?#]/, 1)[0];
    if (!image || image === NFT111K_METADATA.PlaceholderImage) return false;
    let raw: unknown;
    try {
        raw = JSON.parse(metadata.rawJson);
    } catch {
        return false;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const normalizedId = normalizeEvmTokenId(target.tokenId);
    if (normalizedId === null) return false;
    const tokenId = BigInt(normalizedId);
    if (
        CONTAINER_TOKEN_RANGES.some(
            (range) => tokenId >= range.first && tokenId <= range.last,
        )
    )
        return true;
    if (
        tokenId >= NFT111K_TOKEN_RANGES.Artwork.first &&
        tokenId <= NFT111K_TOKEN_RANGES.Artwork.last &&
        Reflect.get(raw, NFT111K_METADATA.Category) === NFT111K_METADATA.Egg
    )
        // An egg is a complete current representation, independent of its future artwork reveal.
        return true;
    if (
        NFT111K_METADATA.RevealStatus in raw &&
        Reflect.get(raw, NFT111K_METADATA.RevealStatus) !==
            NFT111K_METADATA.Revealed
    )
        return false;
    return metadata.attributes.some(
        (attribute) =>
            attribute.traitType === NFT111K_METADATA.CollectionBlock &&
            typeof attribute.value === "string" &&
            attribute.value.trim().length > 0,
    );
}

export const nft111kIndexerExtension: IndexerCollectionExtension = {
    key: NFT111K_EXTENSION_KEY,
    isMetadataReady: isNft111kMetadataReady,
    enumerateBootstrapTokenIds,
    buildSyncWatchSpecs: () => [],
    // Existing canonical-metadata follow-ups can schedule these harmless jobs.
    refreshArtifacts: async () => ({ attributesChanged: false }),
};

async function enumerateBootstrapTokenIds(
    context: CollectionExtensionBootstrapEnumerationContext,
): Promise<string[]> {
    const { rpc, anchor, install, onProgress } = context;
    const config: unknown = JSON.parse(install.configJson);
    if (
        !install.enabled ||
        install.extensionKey !== NFT111K_EXTENSION_KEY ||
        install.chainId !== NFT111K_MAINNET_CHAIN_ID ||
        anchor.chainId !== install.chainId ||
        normalizeAddressRef(context.contract) !==
            NFT111K_MAINNET_CONTRACT_ADDRESS ||
        !config ||
        typeof config !== "object" ||
        !("mainContractAddress" in config) ||
        typeof config.mainContractAddress !== "string" ||
        normalizeAddressRef(config.mainContractAddress) !==
            NFT111K_MAINNET_CONTRACT_ADDRESS ||
        !("deploymentBlock" in config) ||
        config.deploymentBlock !== NFT111K_MAINNET_DEPLOYMENT_BLOCK
    )
        throw new Error(
            "111K bootstrap requires the embedded Ethereum mainnet deployment",
        );
    if (
        !Number.isSafeInteger(anchor.blockNumber) ||
        anchor.blockNumber < NFT111K_MAINNET_DEPLOYMENT_BLOCK ||
        !/^0x[0-9a-fA-F]{64}$/.test(anchor.blockHash)
    )
        throw new ChainSyncConflict("Invalid 111K bootstrap anchor");
    const contract = NFT111K_MAINNET_CONTRACT_ADDRESS as Hex;
    const verifyHeader = async () => {
        const header = await rpc.getBlock(anchor.blockNumber, { fresh: true });
        if (
            header.number !== anchor.blockNumber ||
            header.hash.toLowerCase() !== anchor.blockHash.toLowerCase()
        )
            throw new ChainSyncConflict("111K bootstrap anchor changed");
    };
    const readSupply = async () => {
        const supply = await rpc.readContractAtBlock({
            address: contract,
            abi: NFT111K_BOOTSTRAP_ABI,
            functionName: NFT111K_READ_FUNCTION.TotalSupply,
            block: anchor,
        });
        if (typeof supply !== "bigint" || supply < 0n)
            throw new Error("Invalid 111K anchored totalSupply");
        return supply;
    };
    onProgress({ resolved: 0, total: null });
    await verifyHeader();
    const supply = await readSupply();
    const issued = new Set<string>();
    for (
        let fromBlock = NFT111K_MAINNET_DEPLOYMENT_BLOCK;
        fromBlock <= anchor.blockNumber;
        fromBlock += NFT111K_MINT_LOG_PAGE_BLOCKS
    ) {
        const toBlock = Math.min(
            anchor.blockNumber,
            fromBlock + NFT111K_MINT_LOG_PAGE_BLOCKS - 1,
        );
        const logs = await rpc.getLogs({
            address: contract,
            event: ERC721_ABI[0],
            args: { from: zeroAddress },
            fromBlock,
            toBlock,
        });
        for (const log of logs) {
            const events = decodeNftTransferLog(log);
            const event = events[0];
            if (
                normalizeAddressRef(log.address) !== contract ||
                !Number.isSafeInteger(log.blockNumber) ||
                log.blockNumber < fromBlock ||
                log.blockNumber > toBlock ||
                events.length !== 1 ||
                event?.kind !== COLLECTION_STANDARD.Erc721 ||
                event.decoded.from.toLowerCase() !== zeroAddress ||
                event.decoded.to.toLowerCase() === zeroAddress
            )
                throw new Error("Invalid selected 111K mint Transfer log");
            issued.add(event.decoded.tokenId);
        }
    }
    const candidates = [...issued].sort((left, right) =>
        BigInt(left) < BigInt(right)
            ? -1
            : BigInt(left) > BigInt(right)
              ? 1
              : 0,
    );
    const present: string[] = [];
    onProgress({ resolved: 0, total: candidates.length });
    for (
        let offset = 0;
        offset < candidates.length;
        offset += NFT111K_TOKEN_INFO_BATCH_LIMIT
    ) {
        const batch = candidates.slice(
            offset,
            offset + NFT111K_TOKEN_INFO_BATCH_LIMIT,
        );
        const infos = await rpc.readContractAtBlock({
            address: contract,
            abi: NFT111K_BOOTSTRAP_ABI,
            functionName: NFT111K_READ_FUNCTION.GetTokenInfos,
            args: [batch.map(BigInt)],
            block: anchor,
        });
        if (!Array.isArray(infos) || infos.length !== batch.length)
            throw new Error("Invalid 111K getTokenInfos result count");
        for (let index = 0; index < infos.length; index += 1) {
            const info: unknown = infos[index];
            if (
                !info ||
                typeof info !== "object" ||
                !("kind" in info) ||
                typeof info.kind !== "number" ||
                !ITEM_KINDS.has(info.kind) ||
                !("displayId" in info) ||
                typeof info.displayId !== "bigint" ||
                !("holder" in info) ||
                typeof info.holder !== "string"
            )
                throw new Error("Malformed 111K token info");
            if (info.kind === NFT111K_ITEM_KIND.None) {
                if (
                    info.displayId !== 0n ||
                    info.holder.toLowerCase() !== zeroAddress
                )
                    throw new Error("Inconsistent absent 111K token info");
            } else {
                if (info.displayId <= 0n)
                    throw new Error("Invalid 111K token display ID");
                normalizeErc721Owner(info.holder);
                present.push(batch[index]);
            }
        }
        onProgress({
            resolved: offset + batch.length,
            total: candidates.length,
        });
    }
    // A full-contract checksum detects missing history instead of narrowing the scope.
    if (BigInt(present.length) !== supply || (await readSupply()) !== supply)
        throw new Error("111K anchored inventory does not match totalSupply");
    await verifyHeader();
    if (present.length === 0)
        throw new Error(
            "No tokens exist in the collection scope at the bootstrap anchor",
        );
    return present;
}
