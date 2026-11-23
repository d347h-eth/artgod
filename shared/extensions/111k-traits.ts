import type { TraitFilter } from "../types/browse.js";
import type {
    CollectionViewDescriptor,
    TraitCatalogMapper,
    TraitProjection,
} from "../types/trait-catalog.js";
import { NFT111K_METADATA as META } from "./111k-metadata.js";

const ARTWORKS = { id: "artworks", label: "Artworks" };
const TYPE_LABELS = new Map([
    ["egg", "Eggs"],
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
        if (
            pair.key === META.CollectionBlock ||
            pair.key === META.CollectionBlockAlias
        )
            blocks.add(pair.value);
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
    // Alias-only input cannot establish the primary marketplace key for the whole view.
    if (!pairs.some((pair) => pair.key === META.CollectionBlock))
        return UNCLASSIFIED;
    return {
        id: JSON.stringify(["block", block]),
        label: block,
        parent: ARTWORKS,
        pinnedTraits: [{ key: META.CollectionBlock, value: block }],
    };
}

function identity(pairs: readonly TraitFilter[]): TraitProjection {
    return {
        tree: pairs.map((source) => ({
            kind: "leaf",
            id: JSON.stringify([source.key, source.value]),
            label: source.key,
            value: source.value,
            source,
        })),
        values: pairs.map((native) => ({
            fieldId: native.key,
            label: native.key,
            value: native.value,
            native,
        })),
    };
}

export const nft111kTraitCatalog: TraitCatalogMapper = {
    classify,
    availableVersion: () => IDENTITY_VERSION,
    project(_view, version, pairs) {
        if (version !== IDENTITY_VERSION)
            throw new Error("Unknown 111K mapper version");
        return identity(pairs);
    },
};
