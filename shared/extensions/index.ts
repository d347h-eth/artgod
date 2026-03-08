import { normalizeAddressRef } from "../utils/ref-resolver.js";

export const COLLECTION_EXTENSION_KEYS = {
    Terraforms: "terraforms",
} as const;

export const TERRAFORMS_EXTENSION_ARTIFACT_REFS = {
    V2Media: "terraforms-v2-media",
} as const;

export type CollectionExtensionKey =
    (typeof COLLECTION_EXTENSION_KEYS)[keyof typeof COLLECTION_EXTENSION_KEYS];

export type TerraformsExtensionConfig = {
    mainContractAddress: string;
    rendererV2ContractAddress: string;
    tokenUriV2ContractAddress: string;
    beaconV2ContractAddress: string;
};

export type CollectionExtensionInstall = {
    chainId: number;
    collectionId: number;
    extensionKey: CollectionExtensionKey;
    enabled: boolean;
    configJson: string;
    createdAt: string;
    updatedAt: string;
};

export type EmbeddedCollectionExtensionInstall = {
    extensionKey: CollectionExtensionKey;
    configJson: string;
};

type EmbeddedExtensionMatch = {
    chainId: number;
    contractAddress: string;
    install: EmbeddedCollectionExtensionInstall;
};

const EMBEDDED_EXTENSION_MATCHES: EmbeddedExtensionMatch[] = [
    {
        chainId: 1,
        contractAddress: normalizeAddressRef(
            "0x4E1f41613c9084FdB9E34E11fAE9412427480e56",
        ),
        install: {
            extensionKey: COLLECTION_EXTENSION_KEYS.Terraforms,
            configJson: JSON.stringify({
                mainContractAddress: normalizeAddressRef(
                    "0x4E1f41613c9084FdB9E34E11fAE9412427480e56",
                ),
                rendererV2ContractAddress: normalizeAddressRef(
                    "0x8aF860C8F157F4E3B6A54913BFA6Bb96ab2605C2",
                ),
                tokenUriV2ContractAddress: normalizeAddressRef(
                    "0xfcA647387E28e73E291DD90e7b09fA32bCBB2604",
                ),
                beaconV2ContractAddress: normalizeAddressRef(
                    "0x331512A28A4cF80221aF949B5d43041fF0FC7f01",
                ),
            } satisfies TerraformsExtensionConfig),
        },
    },
];

export function resolveEmbeddedCollectionExtensionInstall(input: {
    chainId: number;
    contractAddress: string;
}): EmbeddedCollectionExtensionInstall | null {
    const normalizedAddress = normalizeAddressRef(input.contractAddress);
    const match = EMBEDDED_EXTENSION_MATCHES.find(
        (candidate) =>
            candidate.chainId === input.chainId &&
            candidate.contractAddress === normalizedAddress,
    );
    return match?.install ?? null;
}

export function parseTerraformsExtensionConfig(
    input: string,
): TerraformsExtensionConfig {
    let raw: unknown;
    try {
        raw = JSON.parse(input);
    } catch {
        throw new Error("Invalid Terraforms extension config JSON");
    }

    if (!raw || typeof raw !== "object") {
        throw new Error("Invalid Terraforms extension config payload");
    }

    const record = raw as Record<string, unknown>;
    return {
        mainContractAddress: asAddress(
            record.mainContractAddress,
            "mainContractAddress",
        ),
        rendererV2ContractAddress: asAddress(
            record.rendererV2ContractAddress,
            "rendererV2ContractAddress",
        ),
        tokenUriV2ContractAddress: asAddress(
            record.tokenUriV2ContractAddress,
            "tokenUriV2ContractAddress",
        ),
        beaconV2ContractAddress: asAddress(
            record.beaconV2ContractAddress,
            "beaconV2ContractAddress",
        ),
    };
}

function asAddress(value: unknown, field: string): string {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`Invalid Terraforms extension config field: ${field}`);
    }
    return normalizeAddressRef(value);
}
