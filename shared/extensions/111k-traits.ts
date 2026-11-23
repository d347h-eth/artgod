import {
    STRUCTURED_BLOCK,
    identityValue,
    sourceLeaf,
    projectPlane,
    projectBackrooms,
    structuredSchema,
} from "./111k-structured-traits.js";
import type { TraitFilter } from "../types/browse.js";
import type {
    CollectionViewDescriptor,
    TraitCatalogMapper,
    TraitProjection,
} from "../types/trait-catalog.js";
import {
    NFT111K_BLOCK_KEYS,
    NFT111K_METADATA as META,
    isNft111kBlockKey,
} from "./111k-metadata.js";

const ARTWORKS = { id: "artworks", label: "Artworks" };
const TYPE_LABELS = new Map([
    [META.Egg, "Eggs"],
    ["crate", "Crates"],
    ["warehouse", "Warehouses"],
    ["relic", "Relics"],
]);
const UNCLASSIFIED: CollectionViewDescriptor = {
    id: "unclassified",
    label: "Unclassified",
    parent: null,
    pinnedTraits: [],
};
const IDENTITY_VERSION = "identity-1";

function classify(pairs: readonly TraitFilter[]): CollectionViewDescriptor {
    const types = new Set<string>();
    const blocks = new Set<string>();
    for (const pair of pairs) {
        if (pair.key === META.Type) types.add(pair.value);
        if (isNft111kBlockKey(pair.key)) blocks.add(pair.value);
    }
    if (types.size > 1 || blocks.size > 1) return UNCLASSIFIED;
    const type = [...types][0];
    const block = [...blocks][0];
    if (type && TYPE_LABELS.has(type)) {
        if (block) return UNCLASSIFIED;
        return {
            id: JSON.stringify(["type", type]),
            label: TYPE_LABELS.get(type)!,
            parent: null,
            pinnedTraits: [{ key: META.Type, value: type }],
        };
    }
    if (!block) return UNCLASSIFIED;
    const nativeKey = NFT111K_BLOCK_KEYS.find((key) =>
        pairs.some((pair) => pair.key === key),
    )!;
    return {
        id: JSON.stringify(["block", block]),
        label: block,
        parent: ARTWORKS,
        pinnedTraits: [{ key: nativeKey, value: block }],
    };
}

function identity(pairs: readonly TraitFilter[]): TraitProjection {
    return {
        tree: pairs.map((pair) => sourceLeaf(pair)),
        values: pairs.map(identityValue),
    };
}

const structuredBlocks = new Map([
    [
        JSON.stringify(["block", STRUCTURED_BLOCK.Plane]),
        {
            block: STRUCTURED_BLOCK.Plane,
            version: "plane-1",
            project: projectPlane,
        },
    ],
    [
        JSON.stringify(["block", STRUCTURED_BLOCK.Backrooms]),
        {
            block: STRUCTURED_BLOCK.Backrooms,
            version: "backrooms-1",
            project: projectBackrooms,
        },
    ],
]);

export const nft111kTraitCatalog: TraitCatalogMapper = {
    unclassified: UNCLASSIFIED,
    classify,
    equivalentPinKeys: (view) =>
        isNft111kBlockKey(view.pinnedTraits[0]?.key) ? NFT111K_BLOCK_KEYS : [],
    availableVersion: (view) =>
        structuredBlocks.get(view.id)?.version ?? IDENTITY_VERSION,
    structure(view, version) {
        const mapping = structuredBlocks.get(view.id);
        return mapping?.version === version
            ? structuredSchema(mapping.block)
            : [];
    },
    project(view, version, pairs) {
        // Existing identity generations keep receiving their own version until publication.
        if (version === IDENTITY_VERSION) return identity(pairs);
        const mapping = structuredBlocks.get(view.id);
        if (mapping?.version === version) return mapping.project(pairs);
        throw new Error("Unknown 111K mapper version");
    },
};
