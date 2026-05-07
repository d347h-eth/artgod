import {
    EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND,
    type EmbeddedCollectionExtensionMatch,
} from "./index.js";
import { normalizeAddressRef } from "../utils/ref-resolver.js";

export const TERRAFORMS_EXTENSION_KEY = "terraforms";

export const TERRAFORMS_EXTENSION_ARTIFACT_REFS = {
    V2Media: "terraforms-v2-media",
    LostTerrain: "terraforms-v2-lost-terrain",
} as const;

export const TERRAFORMS_EXTENSION_EVENT_MEDIA_REFS = {
    TerraformedPreview: "terraformed-preview",
} as const;

export const TERRAFORMS_EXTENSION_EVENT_KEYS = {
    Terraformed: "terraformed",
} as const;

export const TERRAFORMS_EVENT_RENDER_MODES = {
    Network: "network",
    Artifact: "artifact",
} as const;

export const TERRAFORMS_EVENT_RENDER_MODE_OPTIONS = [
    { key: TERRAFORMS_EVENT_RENDER_MODES.Artifact, label: "artifact" },
    { key: TERRAFORMS_EVENT_RENDER_MODES.Network, label: "network" },
] as const;

export const TERRAFORMS_MEDIA_MODES = {
    LostTerrain: "lost-terrain",
} as const;

export const TERRAFORMS_KNOWN_TOKEN_URI_ADDRESSES_BY_INDEX: Readonly<
    Record<string, string>
> = {
    "0": normalizeAddressRef("0xA5aFC9fE76a28fB12C60954Ed6e2e5f8ceF64Ff2"),
    "1": normalizeAddressRef("0xB51A3bB80d50A3153C1b63B0E38FC200676f5bA5"),
    "2": normalizeAddressRef("0x8aF860C8F157F4E3B6A54913BFA6Bb96ab2605C2"),
};

// Immutable seed value from the deployed Terraforms main contract.
export const TERRAFORMS_SEED = 10196n;

// Normal committed canvases render with the Terraformed enum value.
export const TERRAFORMS_TERRAFORMED_STATUS = 2n;

// Origin parcels keep their origin lineage when rendered as committed canvases.
export const TERRAFORMS_ORIGIN_DAYDREAM_STATUS = 3n;
export const TERRAFORMS_ORIGIN_TERRAFORMED_STATUS = 4n;

export const TERRAFORMS_TOKEN_TO_URI_ADDRESS_INDEX_STORAGE_SLOT = 11128n;

export function resolveTerraformsCommittedCanvasStatus(
    tokenStatus: bigint | number,
): bigint {
    return BigInt(tokenStatus) >= TERRAFORMS_ORIGIN_DAYDREAM_STATUS
        ? TERRAFORMS_ORIGIN_TERRAFORMED_STATUS
        : TERRAFORMS_TERRAFORMED_STATUS;
}

export type TerraformsExtensionConfig = {
    mainContractAddress: string;
    rendererV2ContractAddress: string;
    tokenUriV2ContractAddress: string;
    beaconV2ContractAddress: string;
};

export const TERRAFORMS_EMBEDDED_EXTENSION_MATCHES: readonly EmbeddedCollectionExtensionMatch[] =
    [
        {
            chainId: 1,
            contractAddress: normalizeAddressRef(
                "0x4E1f41613c9084FdB9E34E11fAE9412427480e56",
            ),
            scope: {
                kind: EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.AllContractTokens,
            },
            install: {
                extensionKey: TERRAFORMS_EXTENSION_KEY,
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
