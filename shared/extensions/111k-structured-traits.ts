import { TRAIT_NODE_KIND as NODE } from "../types/trait-catalog.js";
import type { TraitFilter } from "../types/browse.js";
import type {
    ProjectedTraitValue,
    TraitNode,
    TraitProjection,
} from "../types/trait-catalog.js";
import {
    NFT111K_METADATA as META,
    isNft111kBlockKey,
} from "./111k-metadata.js";

export const STRUCTURED_BLOCK = {
    Plane: "plane of existence",
    Backrooms: "backrooms 2",
} as const;
const CONSTANT_FIELDS = {
    "3base": "Base",
    "4shirt": "Shirt",
    "5jacket": "Jacket",
    "6mouth": "Mouth",
    "7nose": "Nose",
    "8eyes": "Eyes",
    "9hair": "Hair",
    "91hat": "Hat",
    "92accessory": "Accessory",
};
const CHARACTER_FIELDS = new Map<string, Record<string, string>>([
    [
        "Mini drif",
        {
            "1body": "Body",
            "2body plus": "Body plus",
            "3mouth": "Mouth",
            "4nose": "Nose",
            "5eyes": "Eyes",
            "6head": "Head",
            "7right": "Right",
            "8left": "Left",
            "12outline": "Outline",
        },
    ],
    [
        "M2main",
        {
            "1Aura": "Aura",
            "2Eyes": "Eyes",
            "3Hats": "Hats",
            "4Left wield": "Left wield",
            "5Right wield": "Right wield",
        },
    ],
    [
        "Drifella III middle",
        {
            "H.base pixel line middle": "Base pixel line middle",
            "I.base middle": "Base middle",
            "J.base plus middle": "Base plus middle",
            "L.mouth middle": "Mouth middle",
            "M.eyes middle": "Eyes middle",
            "N.head middle": "Head middle",
        },
    ],
    [
        "Drifella II",
        {
            "3drifellabody": "Body",
            "4tattoos": "Tattoos",
            "6accesory": "Accessory",
            "7mouth": "Mouth",
            "8nose": "Nose",
            "9eyes": "Eyes",
            "91head": "Head",
            "92left": "Left",
            "93right": "Right",
        },
    ],
    ["Constant fella", CONSTANT_FIELDS],
    ["Regular Constant fella", CONSTANT_FIELDS],
    ...[
        "Little Swag World",
        "collage",
        "sprites",
        "GAN egg",
        "Honor thy father figure",
    ].map((name) => [name, {}] as [string, Record<string, string>]),
]);
const TITLE = "Title",
    ARTIST = "Artist",
    REFERENCE = "Artwork reference",
    NAME = "Name";
const PAINTINGS = "Paintings",
    CHARACTERS = "Characters";
const SCENE_FIELDS = new Set(["Chaos", "Paint mark chaos", "Paint mark count"]);
const SCENE_FAMILIES = new Set([
    "architecture",
    "character shadow",
    "emoji drop",
    "emoji drop shadow",
    "isolated paint mark",
    "object ground shadow",
    "paint GAN",
    "pixel color block",
    "portal",
    "small paint mark",
]);
export function identityValue(native: TraitFilter): ProjectedTraitValue {
    return {
        fieldId: native.key,
        label: native.key,
        value: native.value,
        native,
        nativeFieldKey: native.key,
    };
}
export function sourceLeaf(
    source: TraitFilter,
    label = source.key,
    fieldId = source.key,
): TraitNode {
    return {
        kind: NODE.Leaf,
        fieldId,
        id: JSON.stringify([source.key, source.value]),
        label,
        value: source.value,
        source,
    };
}
function group(label: string, children: TraitNode[]): TraitNode {
    return { kind: NODE.Group, id: label, label, children };
}
function add<K, V>(map: Map<K, V[]>, key: K, value: V) {
    const bucket = map.get(key);
    if (bucket) bucket.push(value);
    else map.set(key, [value]);
}
// Ordinals identify source slots, including sparse slots. They carry no spatial semantics.
function sortedSlots<T>(slots: Map<string, T>): [string, T][] {
    return [...slots].sort(
        ([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0),
    );
}
function collectionField(key: string): boolean {
    return isNft111kBlockKey(key) || key === META.Type;
}
export function projectBackrooms(
    pairs: readonly TraitFilter[],
): TraitProjection {
    const paintings = new Map<string, TraitFilter[]>();
    const room: TraitNode[] = [],
        collection: TraitNode[] = [],
        values: ProjectedTraitValue[] = [];
    const primaryBlocks = new Set(
        pairs.filter((p) => p.key === META.CollectionBlock).map((p) => p.value),
    );
    for (const fact of pairs) {
        const painting = /^Painting (\d+)( Artist)?$/.exec(fact.key);
        if (painting) {
            add(paintings, painting[1], fact);
            continue;
        }
        if (
            fact.key === META.CollectionBlockAlias &&
            primaryBlocks.has(fact.value)
        )
            continue;
        const destination = collectionField(fact.key) ? collection : room;
        destination.push(sourceLeaf(fact));
        // Numbered props remain readable in their original form. Only room-level keys become facets.
        if (!/\b\d+\b/.test(fact.key)) values.push(identityValue(fact));
    }
    const instances = sortedSlots(paintings).map(([slot, facts]): TraitNode => {
        const hasArtist = facts.some((f) => f.key.endsWith(" Artist"));
        const hasTitle = facts.some((f) => !f.key.endsWith(" Artist"));
        const missing = !hasArtist
            ? " · artist unknown"
            : !hasTitle
              ? " · title unknown"
              : "";
        return {
            kind: NODE.Entity,
            id: slot,
            label: "Painting " + slot + missing,
            children: facts.map((f) =>
                sourceLeaf(
                    f,
                    f.key.endsWith(" Artist") ? ARTIST : TITLE,
                    JSON.stringify([
                        "painting",
                        f.key.endsWith(" Artist") ? "artist" : "title",
                    ]),
                ),
            ),
        };
    });
    return {
        tree: [
            group("Collection", collection),
            group("Room", room),
            group(PAINTINGS, instances),
        ].filter((n) => n.kind !== NODE.Leaf && n.children.length),
        values,
    };
}

type CharacterFact = { source: TraitFilter; name: string; field: string };
export function projectPlane(pairs: readonly TraitFilter[]): TraitProjection {
    const characters = new Map<string, CharacterFact[]>();
    const collection: TraitNode[] = [],
        scene: TraitNode[] = [],
        other: TraitNode[] = [],
        issues: TraitNode[] = [];
    const families = new Map<string, TraitNode[]>();
    const values: ProjectedTraitValue[] = [];
    for (const fact of pairs) {
        const character = /^Character (\d+)(?: - (.+?)(?: \/ (.+))?)?$/.exec(
            fact.key,
        );
        if (character) {
            const [, slot, name, field] = character;
            add(characters, slot, {
                source: fact,
                name: name ?? fact.value,
                field: field ?? (name ? REFERENCE : NAME),
            });
            continue;
        }
        const numbered = /^(.+) (\d+)$/.exec(fact.key);
        if (numbered && CHARACTER_FIELDS.has(numbered[1])) {
            add(characters, numbered[2], {
                source: fact,
                name: numbered[1],
                field: REFERENCE,
            });
        } else if (numbered && SCENE_FAMILIES.has(numbered[1])) {
            add(families, numbered[1], sourceLeaf(fact));
        } else if (collectionField(fact.key) || SCENE_FIELDS.has(fact.key)) {
            (collectionField(fact.key) ? collection : scene).push(
                sourceLeaf(fact),
            );
            values.push(identityValue(fact));
        } else other.push(sourceLeaf(fact));
    }
    const byName = new Map<
        string,
        { slot: string; facts: CharacterFact[] }[]
    >();
    for (const [slot, facts] of sortedSlots(characters)) {
        const name = facts[0].name;
        if (facts.some((f) => f.name !== name))
            issues.push(
                group(
                    "Character " + slot,
                    facts.map((f) => sourceLeaf(f.source)),
                ),
            );
        else add(byName, name, { slot, facts });
    }
    const known = [...byName].map(([name, instances]) =>
        group(
            name,
            instances.map(({ slot, facts }, index): TraitNode => {
                const fields = CHARACTER_FIELDS.get(name);
                return {
                    kind: NODE.Entity,
                    id: slot,
                    label:
                        instances.length === 1
                            ? name
                            : name + " " + (index + 1),
                    children: facts.map((f) =>
                        sourceLeaf(
                            f.source,
                            fields && Object.hasOwn(fields, f.field)
                                ? fields[f.field]
                                : f.field,
                            JSON.stringify(["character", name, f.field]),
                        ),
                    ),
                };
            }),
        ),
    );
    for (const [name, nodes] of families) scene.push(group(name, nodes));
    const tree = [
        group("Collection", collection),
        group(CHARACTERS, known),
        group("Scene", scene),
        group("Other", other),
        group("Conflicting character names", issues),
    ].filter((n) => n.kind !== NODE.Leaf && n.children.length);
    return { tree, values };
}
