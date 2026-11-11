import { describe, expect, it } from "vitest";
import { BOOTSTRAP_ENUMERATION_MODE as Mode } from "../bootstrap/pipeline.js";
import { EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND as ScopeKind } from "./index.js";
import {
    resolveEmbeddedCollectionBootstrapPreset,
    resolveEmbeddedCollectionExtensionInstall,
    resolveEmbeddedCollectionExtensionInstallByKey,
} from "./built-ins.js";
import {
    NFT111K_EXTENSION_KEY,
    NFT111K_SEPOLIA_CHAIN_ID,
    NFT111K_SEPOLIA_CONTRACT_ADDRESS,
    NFT111K_SEPOLIA_DEPLOYMENT_BLOCK,
} from "./111k.js";
import {
    TERRAFORMS_MAINNET_CHAIN_ID,
    TERRAFORMS_MAINNET_CONTRACT_ADDRESS,
} from "./terraforms.js";

const identity = {
    chainId: NFT111K_SEPOLIA_CHAIN_ID,
    contractAddress: NFT111K_SEPOLIA_CONTRACT_ADDRESS,
};

describe("111K embedded definition", () => {
    it.each([identity.contractAddress, identity.contractAddress.toUpperCase()])(
        "recommends full scope before installation for %s",
        (contractAddress) => {
            expect(
                resolveEmbeddedCollectionBootstrapPreset({
                    ...identity,
                    contractAddress,
                }),
            ).toEqual({
                extensionKey: NFT111K_EXTENSION_KEY,
                scope: { mode: Mode.Enumerable },
            });
            const install = resolveEmbeddedCollectionExtensionInstall({
                ...identity,
                contractAddress,
                scope: { kind: ScopeKind.AllContractTokens },
            });
            expect(install).toEqual(
                resolveEmbeddedCollectionExtensionInstallByKey({
                    chainId: identity.chainId,
                    extensionKey: NFT111K_EXTENSION_KEY,
                }),
            );
            expect(JSON.parse(install!.configJson)).toEqual({
                mainContractAddress: identity.contractAddress,
                deploymentBlock: NFT111K_SEPOLIA_DEPLOYMENT_BLOCK,
            });
        },
    );
    it.each([
        { ...identity, chainId: 1 },
        { ...identity, contractAddress: "0x" + "12".repeat(20) },
        {
            chainId: TERRAFORMS_MAINNET_CHAIN_ID,
            contractAddress: TERRAFORMS_MAINNET_CONTRACT_ADDRESS,
        },
    ])("withholds the preset for another identity: %j", (input) => {
        expect(resolveEmbeddedCollectionBootstrapPreset(input)).toBeNull();
    });
    it.each([
        { kind: ScopeKind.TokenRange, startTokenId: "1", totalSupply: 378 },
        { kind: ScopeKind.ExplicitTokenIds, tokenIds: ["1", "111891"] },
    ])("does not install for a manual scope: %j", (scope) => {
        expect(
            resolveEmbeddedCollectionExtensionInstall({ ...identity, scope }),
        ).toBeNull();
    });
});
