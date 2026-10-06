import {
    ERC721_OWNERSHIP_ABI,
    ERC721_OWNER_OF_FUNCTION,
    isErc721TokenAbsentError,
    normalizeErc721Owner,
} from "@artgod/shared/evm/erc721-ownership";
import type { RpcProviderPort, Hex } from "../../ports/rpc.js";
import type { ChainBlockReference } from "../../domain/chain-sync.js";

// Reads one token at an explicit block; uncertain failures propagate for retry.
export class Erc721TokenOwnership {
    constructor(
        private readonly rpc: Pick<RpcProviderPort, "readContractAtBlock">,
    ) {}

    async readOwner(input: {
        contract: string;
        tokenId: string;
        block: ChainBlockReference;
    }): Promise<string | null> {
        try {
            const owner = await this.rpc.readContractAtBlock<string>({
                address: input.contract as Hex,
                abi: ERC721_OWNERSHIP_ABI,
                functionName: ERC721_OWNER_OF_FUNCTION,
                args: [BigInt(input.tokenId)],
                block: input.block,
            });
            return normalizeErc721Owner(owner);
        } catch (error) {
            if (isErc721TokenAbsentError(error, input.tokenId)) return null;
            throw error;
        }
    }
}
