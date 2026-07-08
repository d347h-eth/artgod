import * as AbiParameters from "ox/AbiParameters";
import * as Hash from "ox/Hash";
import {
    EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND,
    type EmbeddedCollectionExtensionMatch,
} from "./index.js";
import {
    TERRAFORMS_BIOME_ATTRIBUTE_KEY,
    TERRAFORMS_HYPERCASTLE_TOTAL_PARCELS,
    TERRAFORMS_LEVEL_DIMENSIONS,
    TERRAFORMS_LEVEL_ATTRIBUTE_KEY,
    TERRAFORMS_ZONE_ATTRIBUTE_KEY,
} from "./terraforms-structure.js";
import { normalizeAddressRef } from "../utils/ref-resolver.js";
import {
    COLLECTION_STANDARD,
    COLLECTION_STATUS,
} from "../types/browse.js";

export * from "./terraforms-structure.js";

export const TERRAFORMS_EXTENSION_KEY = "terraforms";

// Preset collection slug used for first-launch Terraforms bootstrap setup.
export const TERRAFORMS_COLLECTION_SLUG = "terraforms";

// Ethereum mainnet chain id for the embedded Terraforms collection preset.
export const TERRAFORMS_MAINNET_CHAIN_ID = 1;

// Deployed Terraforms main contract used by embedded extension matching.
export const TERRAFORMS_MAINNET_CONTRACT_ADDRESS = normalizeAddressRef(
    "0x4E1f41613c9084FdB9E34E11fAE9412427480e56",
);

// Terraforms deployment block used as the bootstrap lower-bound hint.
export const TERRAFORMS_MAINNET_DEPLOYMENT_BLOCK = 13_823_015;

// OpenSea collection slug for Terraforms market/orderbook sync.
export const TERRAFORMS_OPENSEA_SLUG = TERRAFORMS_COLLECTION_SLUG;

// ERC token standard exposed by the Terraforms main contract.
export const TERRAFORMS_COLLECTION_STANDARD = COLLECTION_STANDARD.Erc721;

// Terraforms main-contract max supply and placement domain size.
export const TERRAFORMS_MAX_SUPPLY = TERRAFORMS_HYPERCASTLE_TOTAL_PARCELS;

// First-launch collection preset persisted without token/bootstrap rows.
export const TERRAFORMS_MAINNET_PRESET_COLLECTION = {
    chainId: TERRAFORMS_MAINNET_CHAIN_ID,
    collectionId: 1,
    slug: TERRAFORMS_COLLECTION_SLUG,
    address: TERRAFORMS_MAINNET_CONTRACT_ADDRESS,
    standard: TERRAFORMS_COLLECTION_STANDARD,
    status: COLLECTION_STATUS.Prepared,
    tokenScopeKind: EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.AllContractTokens,
    deploymentBlock: TERRAFORMS_MAINNET_DEPLOYMENT_BLOCK,
    openseaSlug: TERRAFORMS_OPENSEA_SLUG,
} as const;

// Extension-owned token id prefix for settled placements that have not minted.
export const TERRAFORMS_UNMINTED_TOKEN_ID_PREFIX = "unminted-tile";

export const TERRAFORMS_EXTENSION_ARTIFACT_REFS = {
    V2Media: "terraforms-v2-media",
    LostTerrain: "terraforms-v2-lost-terrain",
} as const;

export const TERRAFORMS_EXTENSION_EVENT_MEDIA_REFS = {
    TerraformedPreview: "terraformed-preview",
} as const;

export const TERRAFORMS_EXTENSION_EVENT_KEYS = {
    Terraformed: "terraformed",
    Beacon: "beacon",
} as const;

// Terraforms collection page refs exposed through the frontend extension page port.
export const TERRAFORMS_EXTENSION_PAGE_REFS = {
    Hypercastle: "hypercastle",
} as const;

// Terraforms beacon rows use one feed with token-owner and Mathcastles admin groups.
export const TERRAFORMS_BEACON_EVENT_GROUPS = {
    ParcelModified: "parcel_modified",
    Mathcastles: "mathcastles",
} as const;

// User-facing filter options for Terraforms beacon event groups.
export const TERRAFORMS_BEACON_EVENT_GROUP_OPTIONS = [
    {
        key: TERRAFORMS_BEACON_EVENT_GROUPS.ParcelModified,
        label: "Parcel Modified",
    },
    { key: TERRAFORMS_BEACON_EVENT_GROUPS.Mathcastles, label: "Mathcastles" },
] as const;

// Concrete Terraforms beacon contract events stored in beacon activity payloads.
export const TERRAFORMS_BEACON_EVENT_TYPES = {
    ParcelModified: "parcel_modified",
    BroadcastAdded: "broadcast_added",
    BroadcastRemoved: "broadcast_removed",
    BroadcastModified: "broadcast_modified",
    BroadcastOrderModified: "broadcast_order_modified",
    ScriptComponentModified: "script_component_modified",
} as const;

// Compact labels for concrete Terraforms beacon event types.
export const TERRAFORMS_BEACON_EVENT_TYPE_LABELS: Readonly<
    Record<string, string>
> = {
    [TERRAFORMS_BEACON_EVENT_TYPES.ParcelModified]: "Parcel Modified",
    [TERRAFORMS_BEACON_EVENT_TYPES.BroadcastAdded]: "Broadcast Added",
    [TERRAFORMS_BEACON_EVENT_TYPES.BroadcastRemoved]: "Broadcast Removed",
    [TERRAFORMS_BEACON_EVENT_TYPES.BroadcastModified]: "Broadcast Modified",
    [TERRAFORMS_BEACON_EVENT_TYPES.BroadcastOrderModified]:
        "Broadcast Order Modified",
    [TERRAFORMS_BEACON_EVENT_TYPES.ScriptComponentModified]:
        "Script Component Modified",
};

// Terraforms beacon AntennaModification enum values from Types.sol.
export const TERRAFORMS_BEACON_ANTENNA_MODIFICATIONS = {
    TurnedAntennaOff: 0,
    TurnedAntennaOn: 1,
    TunedToCapturedSatelliteConnection: 2,
    CapturedSatelliteConnection: 3,
} as const;

// Terraforms beacon read methods used by extension-owned trait derivation.
export const TERRAFORMS_BEACON_V2_READ_FUNCTIONS = {
    GetNumberOfAntennaModifications: "getNumberOfAntennaModifications",
    GetFirstAntennaModification: "getFirstAntennaModification",
} as const;

// Terraforms main-contract read methods used by live media and renderer lookup.
export const TERRAFORMS_MAIN_READ_FUNCTIONS = {
    TokenHtml: "tokenHTML",
    TokenToPlacement: "tokenToPlacement",
    TokenToStatus: "tokenToStatus",
    TokenUri: "tokenURI",
    TokenUriAddresses: "tokenURIAddresses",
} as const;

// Compact labels for Terraforms beacon AntennaModification values.
export const TERRAFORMS_BEACON_ANTENNA_MODIFICATION_LABELS: Readonly<
    Record<string, string>
> = {
    [TERRAFORMS_BEACON_ANTENNA_MODIFICATIONS.TurnedAntennaOff]: "antenna off",
    [TERRAFORMS_BEACON_ANTENNA_MODIFICATIONS.TurnedAntennaOn]: "antenna on",
    [TERRAFORMS_BEACON_ANTENNA_MODIFICATIONS.TunedToCapturedSatelliteConnection]:
        "tuned to captured satellite",
    [TERRAFORMS_BEACON_ANTENNA_MODIFICATIONS.CapturedSatelliteConnection]:
        "captured satellite connection",
};

// Terraforms beacon ScriptComponent enum values from TerraformsBeacon_v2_0.sol.
export const TERRAFORMS_BEACON_SCRIPT_COMPONENTS = {
    Library: 0,
    Font: 1,
    Extra1: 2,
    Body: 3,
    UI: 4,
    Extra2: 5,
    LoopStart: 6,
    LoopEnd: 7,
} as const;

// Compact labels for Terraforms beacon ScriptComponent values.
export const TERRAFORMS_BEACON_SCRIPT_COMPONENT_LABELS: Readonly<
    Record<string, string>
> = {
    [TERRAFORMS_BEACON_SCRIPT_COMPONENTS.Library]: "library",
    [TERRAFORMS_BEACON_SCRIPT_COMPONENTS.Font]: "font",
    [TERRAFORMS_BEACON_SCRIPT_COMPONENTS.Extra1]: "extra1",
    [TERRAFORMS_BEACON_SCRIPT_COMPONENTS.Body]: "body",
    [TERRAFORMS_BEACON_SCRIPT_COMPONENTS.UI]: "ui",
    [TERRAFORMS_BEACON_SCRIPT_COMPONENTS.Extra2]: "extra2",
    [TERRAFORMS_BEACON_SCRIPT_COMPONENTS.LoopStart]: "loop start",
    [TERRAFORMS_BEACON_SCRIPT_COMPONENTS.LoopEnd]: "loop end",
};

// Terraforms stores the token state in metadata under this trait key.
export const TERRAFORMS_MODE_ATTRIBUTE_KEY = "Mode";

// Metadata Mode trait values mirror Terraforms onchain state names.
export const TERRAFORMS_MODE_ATTRIBUTE_VALUES = {
    Terrain: "Terrain",
    Daydream: "Daydream",
    Terraform: "Terraform",
    OriginDaydream: "Origin Daydream",
    OriginTerraform: "Origin Terraform",
} as const;

// Terraforms metadata stores renderer activation under this trait key.
export const TERRAFORMS_CHROMA_ATTRIBUTE_KEY = "Chroma";

// Terraforms V2 renderer metadata stores Beacon antenna state under this trait key.
export const TERRAFORMS_ANTENNA_ATTRIBUTE_KEY = "Antenna";

// Terraforms V2 renderer antenna trait values mirror AntennaStatus labels.
export const TERRAFORMS_ANTENNA_ATTRIBUTE_VALUES = {
    Off: "Off",
    On: "On",
    Uplink: "Uplink",
} as const;

// Terraforms extension-owned trait key that separates real and synthetic rows.
export const TERRAFORMS_MINTED_ATTRIBUTE_KEY = "Minted";

// Terraforms stores Minted as string values so trait filters stay categorical.
export const TERRAFORMS_MINTED_ATTRIBUTE_VALUES = {
    True: "true",
    False: "false",
} as const;

// Terraforms extension-owned trait key for historical Beacon participation.
export const TERRAFORMS_SEASONS_ATTRIBUTE_KEY = "Seasons";

// Terraforms Season trait values are categorical filter buckets.
export const TERRAFORMS_SEASON_ATTRIBUTE_VALUES = {
    Season0: "Season 0",
} as const;

export type TerraformsSeasonAttributeValue =
    (typeof TERRAFORMS_SEASON_ATTRIBUTE_VALUES)[keyof typeof TERRAFORMS_SEASON_ATTRIBUTE_VALUES];

// First antenna-on timestamps before this Unix second qualify for Season 0.
export const TERRAFORMS_SEASON_0_ANTENNA_ON_CUTOFF_TIMESTAMP = 1705122113n;

// Tokens in these Mode states can have or receive owner-written dream canvases.
export const TERRAFORMS_DREAM_MODE_ATTRIBUTE_VALUES = [
    TERRAFORMS_MODE_ATTRIBUTE_VALUES.Daydream,
    TERRAFORMS_MODE_ATTRIBUTE_VALUES.Terraform,
    TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginDaydream,
    TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginTerraform,
] as const;

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
    Live: "live",
} as const;

// Terraforms token-local and collection-level media labels exposed by backend.
export const TERRAFORMS_MEDIA_MODE_OPTIONS = {
    LostTerrain: { key: TERRAFORMS_MEDIA_MODES.LostTerrain, label: "lost" },
    Live: { key: TERRAFORMS_MEDIA_MODES.Live, label: "live" },
} as const;

export const TERRAFORMS_KNOWN_TOKEN_URI_ADDRESSES_BY_INDEX: Readonly<
    Record<string, string>
> = {
    "0": normalizeAddressRef("0xA5aFC9fE76a28fB12C60954Ed6e2e5f8ceF64Ff2"),
    "1": normalizeAddressRef("0xB51A3bB80d50A3153C1b63B0E38FC200676f5bA5"),
    "2": normalizeAddressRef("0x8aF860C8F157F4E3B6A54913BFA6Bb96ab2605C2"),
};

// Immutable placement rotation seed from the deployed Terraforms main contract.
export const TERRAFORMS_PLACEMENT_SEED = 10196n;

// Terraforms renderer seed is a hidden per-token value derived from level/tile.
export const TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY = "Seed";

// Terraforms seed classes expose renderer character-set buckets as traits.
export const TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY = "Seed Class";

// Terraforms renderer seed class values used for first-class trait filtering.
export const TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES = {
    XSeed: "X-Seed",
    YSeed: "Y-Seed",
    Godmode: "Godmode",
} as const;

// Default Terraforms trait summary shared by token cards and activity rows.
export const TERRAFORMS_TRAIT_SUMMARY_TEMPLATE =
    `{${TERRAFORMS_ZONE_ATTRIBUTE_KEY}} B{${TERRAFORMS_BIOME_ATTRIBUTE_KEY}} ` +
    `{${TERRAFORMS_CHROMA_ATTRIBUTE_KEY}} L{${TERRAFORMS_LEVEL_ATTRIBUTE_KEY}}\n` +
    `{${TERRAFORMS_MODE_ATTRIBUTE_KEY}}` +
    `{{#if ${TERRAFORMS_ANTENNA_ATTRIBUTE_KEY}=${TERRAFORMS_ANTENNA_ATTRIBUTE_VALUES.On}}} A{{/if}}` +
    `{{#if ${TERRAFORMS_SEASONS_ATTRIBUTE_KEY}=${TERRAFORMS_SEASON_ATTRIBUTE_VALUES.Season0}}} S0{{/if}}` +
    `{{#if ${TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY}}} {${TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY}}{{/if}}`;

// Terraforms renderer seed buckets mirror animation-v2.js character-set branches.
export const TERRAFORMS_RENDERER_SEED_THRESHOLDS = {
    OriginXSeed: 9000n,
    OverdriveLowerExclusive: 9950n,
    YSeedUpperInclusive: 9970n,
    NonOriginXSeed: 9970n,
    Modulus: 10_000n,
} as const;

// V2 renderer extra character ranges mirror animation-v2.js `uni` starts.
export const TERRAFORMS_RENDERER_EXTRA_CHARACTER_RANGE_STARTS = [
    9600, 9610, 9620, 3900, 9812, 9120, 9590, 143345, 48, 143672, 143682,
    143692, 143702, 820, 8210, 8680, 9573, 142080, 142085, 142990, 143010,
    143030, 9580, 9540, 1470, 143762, 143790, 143810,
] as const;

// Each V2 renderer extra range contributes ten UTF-16 code units.
export const TERRAFORMS_RENDERER_EXTRA_CHARACTER_RANGE_LENGTH = 10;

// Normal committed canvases render with the Terraformed enum value.
export const TERRAFORMS_TERRAFORMED_STATUS = 2n;

// Origin parcels keep their origin lineage when rendered as committed canvases.
export const TERRAFORMS_ORIGIN_DAYDREAM_STATUS = 3n;
export const TERRAFORMS_ORIGIN_TERRAFORMED_STATUS = 4n;

export const TERRAFORMS_TOKEN_TO_URI_ADDRESS_INDEX_STORAGE_SLOT = 11128n;

// Terraforms canvases are stored and rendered as exactly sixteen uint256 rows.
export const TERRAFORMS_CANVAS_ROW_COUNT = 16;

type TerraformsCanvasTuple = readonly [
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
];

export function resolveTerraformsCommittedCanvasStatus(
    tokenStatus: bigint | number,
): bigint {
    return BigInt(tokenStatus) >= TERRAFORMS_ORIGIN_DAYDREAM_STATUS
        ? TERRAFORMS_ORIGIN_TERRAFORMED_STATUS
        : TERRAFORMS_TERRAFORMED_STATUS;
}

// Checks whether a token Mode trait should expose dream-specific UI affordances.
export function isTerraformsDreamMode(
    value: string | null | undefined,
): boolean {
    return TERRAFORMS_DREAM_MODE_ATTRIBUTE_VALUES.includes(
        value as (typeof TERRAFORMS_DREAM_MODE_ATTRIBUTE_VALUES)[number],
    );
}

// Checks whether Mode should use the Terraforms origin renderer branches.
export function isTerraformsOriginMode(
    value: string | null | undefined,
): boolean {
    return (
        value === TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginDaydream ||
        value === TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginTerraform
    );
}

// Resolves Season filters from the Beacon contract's first antenna mutation.
export function resolveTerraformsSeasonValuesFromFirstAntennaModification(params: {
    modification: bigint | number | null | undefined;
    timestamp: bigint | number | null | undefined;
}): TerraformsSeasonAttributeValue[] {
    if (params.modification === null || params.modification === undefined) {
        return [];
    }
    if (params.timestamp === null || params.timestamp === undefined) {
        return [];
    }
    if (
        BigInt(params.modification) !==
        BigInt(TERRAFORMS_BEACON_ANTENNA_MODIFICATIONS.TurnedAntennaOn)
    ) {
        return [];
    }
    if (
        BigInt(params.timestamp) <
        TERRAFORMS_SEASON_0_ANTENNA_ON_CUTOFF_TIMESTAMP
    ) {
        return [TERRAFORMS_SEASON_ATTRIBUTE_VALUES.Season0];
    }
    return [];
}

export type TerraformsLevelTile = {
    level: bigint;
    tile: bigint;
};

export type TerraformsSeedClass =
    (typeof TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES)[keyof typeof TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES];

// Resolves the zero-based level/tile pair consumed by the renderer seed hash.
export function resolveTerraformsLevelAndTileFromPlacement(
    placement: bigint | number,
    placementSeed: bigint | number = TERRAFORMS_PLACEMENT_SEED,
): TerraformsLevelTile {
    const rotated =
        (BigInt(placement) + BigInt(placementSeed)) %
        BigInt(TERRAFORMS_HYPERCASTLE_TOTAL_PARCELS);
    let previousLevelStart = 0n;
    let currentLevelEnd = 0n;

    for (const [
        levelIndex,
        dimension,
    ] of TERRAFORMS_LEVEL_DIMENSIONS.entries()) {
        currentLevelEnd += BigInt(dimension) ** 2n;
        if (rotated < currentLevelEnd) {
            return {
                level: BigInt(levelIndex),
                tile: rotated - previousLevelStart,
            };
        }
        previousLevelStart = currentLevelEnd;
    }

    throw new Error(
        `Terraforms placement ${placement.toString()} is out of range`,
    );
}

// Builds the extension-owned token id for an unminted Terraforms placement.
export function buildTerraformsUnmintedTokenId(
    placement: bigint | number,
): string {
    return `${TERRAFORMS_UNMINTED_TOKEN_ID_PREFIX}-${normalizeTerraformsPlacement(placement).toString()}`;
}

// Parses an extension-owned unminted token id back to its Terraforms placement.
export function parseTerraformsUnmintedTokenId(tokenId: string): bigint | null {
    const prefix = `${TERRAFORMS_UNMINTED_TOKEN_ID_PREFIX}-`;
    if (!tokenId.startsWith(prefix)) {
        return null;
    }
    const rawPlacement = tokenId.slice(prefix.length);
    if (!/^\d+$/.test(rawPlacement)) {
        return null;
    }
    return normalizeTerraformsPlacement(BigInt(rawPlacement));
}

// Computes the settled placement ids that do not yet have a minted token.
export function resolveTerraformsUnmintedPlacements(
    mintedPlacements: Iterable<bigint | number>,
): bigint[] {
    const minted = new Set<string>();
    for (const placement of mintedPlacements) {
        minted.add(normalizeTerraformsPlacement(placement).toString());
    }

    const unminted: bigint[] = [];
    for (
        let placement = 0n;
        placement < BigInt(TERRAFORMS_MAX_SUPPLY);
        placement += 1n
    ) {
        if (!minted.has(placement.toString())) {
            unminted.push(placement);
        }
    }
    return unminted;
}

function normalizeTerraformsPlacement(placement: bigint | number): bigint {
    const value = BigInt(placement);
    if (value < 0n || value >= BigInt(TERRAFORMS_MAX_SUPPLY)) {
        throw new Error(
            `Terraforms placement ${value.toString()} is out of range`,
        );
    }
    return value;
}

// Calculates the hidden per-token renderer seed emitted into Terraforms HTML.
export function calculateTerraformsRendererSeed(
    level: bigint | number,
    tile: bigint | number,
): bigint {
    return (
        BigInt(
            Hash.keccak256(
                AbiParameters.encodePacked(
                    ["uint256", "uint256"],
                    [BigInt(level), BigInt(tile)],
                ),
            ),
        ) % TERRAFORMS_RENDERER_SEED_THRESHOLDS.Modulus
    );
}

// Classifies renderer seed buckets that change Terraforms character-set behavior.
export function resolveTerraformsRendererSeedClass(params: {
    mode: string | null | undefined;
    seed: bigint | number;
}): TerraformsSeedClass | null {
    const seed = BigInt(params.seed);
    const isOrigin = isTerraformsOriginMode(params.mode);
    const isYSeedRange =
        seed > TERRAFORMS_RENDERER_SEED_THRESHOLDS.OverdriveLowerExclusive &&
        seed <= TERRAFORMS_RENDERER_SEED_THRESHOLDS.YSeedUpperInclusive;

    if (
        isOrigin &&
        seed > TERRAFORMS_RENDERER_SEED_THRESHOLDS.OverdriveLowerExclusive
    ) {
        return TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.Godmode;
    }
    if (
        (isOrigin && seed > TERRAFORMS_RENDERER_SEED_THRESHOLDS.OriginXSeed) ||
        (!isOrigin && seed > TERRAFORMS_RENDERER_SEED_THRESHOLDS.NonOriginXSeed)
    ) {
        return TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed;
    }
    if (!isOrigin && isYSeedRange) {
        return TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.YSeed;
    }
    return null;
}

// Calculates and classifies the hidden Terraforms renderer seed for a placement.
export function resolveTerraformsRendererSeedTraits(params: {
    mode: string | null | undefined;
    placement: bigint | number;
    placementSeed?: bigint | number;
}): {
    seed: bigint;
    seedClass: TerraformsSeedClass | null;
    levelTile: TerraformsLevelTile;
} {
    const levelTile = resolveTerraformsLevelAndTileFromPlacement(
        params.placement,
        params.placementSeed ?? TERRAFORMS_PLACEMENT_SEED,
    );
    const seed = calculateTerraformsRendererSeed(
        levelTile.level,
        levelTile.tile,
    );
    return {
        seed,
        seedClass: resolveTerraformsRendererSeedClass({
            mode: params.mode,
            seed,
        }),
        levelTile,
    };
}

// Builds one V2 renderer extra range with String.fromCharCode truncation semantics.
export function buildTerraformsRendererExtraCharacterRange(
    start: number,
): readonly string[] {
    return Array.from(
        { length: TERRAFORMS_RENDERER_EXTRA_CHARACTER_RANGE_LENGTH },
        (_, index) => String.fromCharCode(start + index),
    );
}

// Builds all V2 renderer extra ranges in the canonical renderer order.
export function buildTerraformsRendererExtraCharacterRanges(): readonly (readonly string[])[] {
    return TERRAFORMS_RENDERER_EXTRA_CHARACTER_RANGE_STARTS.map((start) =>
        buildTerraformsRendererExtraCharacterRange(start),
    );
}

// Parses user-pasted Terraforms heightmaps into the same rows stored by the contract.
export function parseTerraformsCanvasRowsText(input: string): bigint[] {
    const rows = input.trim().split(/\s+/).filter(Boolean);
    if (rows.length !== TERRAFORMS_CANVAS_ROW_COUNT) {
        throw new Error("Terraforms heightmap must contain exactly 16 rows");
    }
    return rows.map(parseTerraformsCanvasRow);
}

// Normalizes canvas rows before hashing or renderer calls.
export function normalizeTerraformsCanvasRows(
    rows: readonly bigint[],
): bigint[] {
    const output = [...rows];
    while (output.length < TERRAFORMS_CANVAS_ROW_COUNT) {
        output.push(0n);
    }
    return output.slice(0, TERRAFORMS_CANVAS_ROW_COUNT);
}

// Computes the canonical Terraforms canvas content hash used by extension event feeds.
export function hashTerraformsCanvasRows(rows: readonly bigint[]): string {
    const canvas = normalizeTerraformsCanvasRows(rows);
    return Hash.keccak256(
        AbiParameters.encode(
            [{ type: "uint256[16]", name: "canvas" }],
            [canvas as unknown as TerraformsCanvasTuple],
        ),
    );
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
            chainId: TERRAFORMS_MAINNET_CHAIN_ID,
            contractAddress: TERRAFORMS_MAINNET_CONTRACT_ADDRESS,
            scope: {
                kind: EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.AllContractTokens,
            },
            install: {
                extensionKey: TERRAFORMS_EXTENSION_KEY,
                configJson: JSON.stringify({
                    mainContractAddress: TERRAFORMS_MAINNET_CONTRACT_ADDRESS,
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

function parseTerraformsCanvasRow(row: string): bigint {
    if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(row)) {
        throw new Error("Invalid Terraforms heightmap row");
    }
    const value = BigInt(row);
    if (value < 0n || value > (1n << 256n) - 1n) {
        throw new Error("Terraforms heightmap row is outside uint256 range");
    }
    return value;
}
