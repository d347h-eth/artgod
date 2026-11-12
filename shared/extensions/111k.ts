import { BOOTSTRAP_ENUMERATION_MODE } from "../bootstrap/pipeline.js";
import { normalizeAddressRef } from "../utils/ref-resolver.js";
import {
    EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND,
    type EmbeddedCollectionExtensionMatch,
} from "./index.js";

export const NFT111K_EXTENSION_KEY = "111k";
export const NFT111K_MAINNET_CHAIN_ID = 1;
export const NFT111K_MAINNET_CONTRACT_ADDRESS = normalizeAddressRef(
    "0x08cDed8258730bda384FF198001E47a1B50f7f9d",
);
// The verified constructor does not mint; ordinary mint Transfer logs start here.
export const NFT111K_MAINNET_DEPLOYMENT_BLOCK = 26_387_160;

export const NFT111K_EMBEDDED_EXTENSION_MATCHES: readonly EmbeddedCollectionExtensionMatch[] =
    [
        {
            chainId: NFT111K_MAINNET_CHAIN_ID,
            contractAddress: NFT111K_MAINNET_CONTRACT_ADDRESS,
            scope: {
                kind: EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.AllContractTokens,
            },
            bootstrapPreset: {
                scope: { mode: BOOTSTRAP_ENUMERATION_MODE.Enumerable },
            },
            install: {
                extensionKey: NFT111K_EXTENSION_KEY,
                configJson: JSON.stringify({
                    mainContractAddress: NFT111K_MAINNET_CONTRACT_ADDRESS,
                    deploymentBlock: NFT111K_MAINNET_DEPLOYMENT_BLOCK,
                }),
            },
        },
    ];
