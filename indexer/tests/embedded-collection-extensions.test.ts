import { describe, expect, it } from "vitest";
import {
    resolveEmbeddedCollectionExtensionInstall,
    resolveEmbeddedCollectionExtensionInstallByKey,
} from "@artgod/shared/extensions/built-ins";
import { EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND } from "@artgod/shared/extensions";
import { TERRAFORMS_EXTENSION_KEY } from "@artgod/shared/extensions/terraforms";

const EMBEDDED_TERRAFORMS_MAIN_ADDRESS =
    "0x4e1f41613c9084fdb9e34e11fae9412427480e56";

describe("embedded collection extension resolution", () => {
    it("resolves Terraforms for exact contract and all-contract token scope", () => {
        const install = resolveEmbeddedCollectionExtensionInstall({
            chainId: 1,
            contractAddress: EMBEDDED_TERRAFORMS_MAIN_ADDRESS,
            scope: {
                kind: EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.AllContractTokens,
            },
        });

        expect(install?.extensionKey).toBe(
            TERRAFORMS_EXTENSION_KEY,
        );
    });

    it("does not resolve Terraforms when token scope differs", () => {
        const tokenRangeInstall = resolveEmbeddedCollectionExtensionInstall({
            chainId: 1,
            contractAddress: EMBEDDED_TERRAFORMS_MAIN_ADDRESS,
            scope: {
                kind: EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.TokenRange,
                startTokenId: "0",
                totalSupply: 100,
            },
        });
        const explicitTokenInstall = resolveEmbeddedCollectionExtensionInstall({
            chainId: 1,
            contractAddress: EMBEDDED_TERRAFORMS_MAIN_ADDRESS,
            scope: {
                kind: EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.ExplicitTokenIds,
                tokenIds: ["1", "2", "3"],
            },
        });

        expect(tokenRangeInstall).toBeNull();
        expect(explicitTokenInstall).toBeNull();
    });

    it("resolves embedded extension install config by key for bootstrap worker", () => {
        const install = resolveEmbeddedCollectionExtensionInstallByKey({
            chainId: 1,
            extensionKey: TERRAFORMS_EXTENSION_KEY,
        });

        expect(install?.extensionKey).toBe(
            TERRAFORMS_EXTENSION_KEY,
        );
        expect(install?.configJson).toContain("mainContractAddress");
    });
});
