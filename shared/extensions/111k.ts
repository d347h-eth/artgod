import { BOOTSTRAP_ENUMERATION_MODE } from "../bootstrap/pipeline.js";
import { normalizeAddressRef } from "../utils/ref-resolver.js";
import {
    EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND,
    type EmbeddedCollectionExtensionMatch,
} from "./index.js";

export const NFT111K_EXTENSION_KEY = "111k";
export const NFT111K_SEPOLIA_CHAIN_ID = 11_155_111;
export const NFT111K_SEPOLIA_CONTRACT_ADDRESS = normalizeAddressRef(
    "0xAca342968965Ddb20baDb1943B99Ee6523658619",
);
// v17 has no constructor mints; ordinary mint Transfer logs start here.
export const NFT111K_SEPOLIA_DEPLOYMENT_BLOCK = 12_092_412;

export const NFT111K_EMBEDDED_EXTENSION_MATCHES: readonly EmbeddedCollectionExtensionMatch[] =
    [
        {
            chainId: NFT111K_SEPOLIA_CHAIN_ID,
            contractAddress: NFT111K_SEPOLIA_CONTRACT_ADDRESS,
            scope: {
                kind: EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.AllContractTokens,
            },
            bootstrapPreset: {
                scope: { mode: BOOTSTRAP_ENUMERATION_MODE.Enumerable },
            },
            install: {
                extensionKey: NFT111K_EXTENSION_KEY,
                configJson: JSON.stringify({
                    mainContractAddress: NFT111K_SEPOLIA_CONTRACT_ADDRESS,
                    deploymentBlock: NFT111K_SEPOLIA_DEPLOYMENT_BLOCK,
                }),
            },
        },
    ];
