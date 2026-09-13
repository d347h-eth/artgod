import {
    ERC721_OWNERSHIP_ABI,
    ERC721_OWNER_OF_FUNCTION,
    isErc721TokenAbsentError,
    normalizeErc721Owner,
} from "@artgod/shared/evm/erc721-ownership";
import type { RpcProviderPort, Hex } from "../../ports/rpc.js";

// Reads one token at the bootstrap anchor; unknown failures propagate to the step's retry path.
export class Erc721TokenOwnership {
    constructor(private readonly rpc: Pick<RpcProviderPort, "readContract">) {}

    async readOwner(
        address: string,
        tokenId: string,
        anchorBlock: number,
    ): Promise<string | null> {
        try {
            const owner = await this.rpc.readContract<string>({
                address: address as Hex,
                abi: ERC721_OWNERSHIP_ABI,
                functionName: ERC721_OWNER_OF_FUNCTION,
                args: [BigInt(tokenId)],
                blockNumber: anchorBlock,
            });
            return normalizeErc721Owner(owner);
        } catch (error) {
            if (isErc721TokenAbsentError(error)) return null;
            throw error;
        }
    }
}
