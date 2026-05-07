import { ReadModelNotFoundError } from "@artgod/shared/read-models/errors";
import type { CollectionExtensionInstall } from "@artgod/shared/extensions";
import type { BackendCollectionExtensionRenderContext } from "../../application/collection-extensions/types.js";
import { resolveBackendCollectionExtension } from "../../application/collection-extensions/index.js";

const ERC721_TOKEN_URI_ABI = [
    {
        name: "tokenURI",
        type: "function",
        stateMutability: "view",
        inputs: [{ type: "uint256", name: "tokenId" }],
        outputs: [{ type: "string" }],
    },
] as const;

type CollectionExtensionRecordsPort = {
    getInstallByCollectionId(
        chainId: number,
        collectionId: number,
    ): CollectionExtensionInstall | null;
};

export class ExtensionAwareTokenUriRead {
    constructor(
        private readonly extensionRecords: CollectionExtensionRecordsPort,
        private readonly rpc: BackendCollectionExtensionRenderContext["rpc"],
    ) {}

    async getTokenUri(params: {
        chainId: number;
        collectionId: number;
        contract: string;
        tokenId: string;
    }): Promise<string> {
        const install = this.extensionRecords.getInstallByCollectionId(
            params.chainId,
            params.collectionId,
        );
        const extension = install?.enabled
            ? resolveBackendCollectionExtension(install)
            : null;
        if (install && extension?.resolveTokenUri) {
            const extensionUri = await extension.resolveTokenUri(
                install,
                params,
                {
                    rpc: this.rpc,
                },
            );
            if (extensionUri) return extensionUri;
        }

        try {
            return await this.rpc.readContract<string>({
                address: params.contract as `0x${string}`,
                abi: ERC721_TOKEN_URI_ABI,
                functionName: "tokenURI",
                args: [BigInt(params.tokenId)],
            });
        } catch {
            throw new ReadModelNotFoundError("Token URI not found");
        }
    }
}
