import { describe, expect, it } from "vitest";
import type { TraitFilter } from "../types/browse.js";
import type { TraitNode } from "../types/trait-catalog.js";
import { NFT111K_METADATA, nft111kTraitCatalog as mapper } from "./111k.js";
import { STRUCTURED_BLOCK } from "./111k-structured-traits.js";

function project(block: string, pairs: [string, string][]) {
    const facts = [
        { key: NFT111K_METADATA.CollectionBlock, value: block },
        ...pairs.map(([key, value]) => ({ key, value })),
    ];
    const view = mapper.classify(facts);
    return mapper.project(view, mapper.availableVersion(view), facts);
}
function children(nodes: TraitNode[], label: string): TraitNode[] {
    const found = nodes.find((node) => node.label === label);
    if (!found || found.kind === "leaf")
        throw new Error("Missing group " + label);
    return found.children;
}
describe("structured artwork traits", () => {
    it("keeps character slots, reference forms and unmapped facts distinct", () => {
        const { tree, values } = project(STRUCTURED_BLOCK.Plane, [
            ["Character 12", "Mini drif"],
            ["Character 12 - Mini drif / 1body", "red"],
            ["Character 12 - Mini drif / 1body", "blue"],
            ["Character 2 - Mini drif / 7right", "arm"],
            ["Character 4 - M2main / 4Left wield", "lamp"],
            ["sprites 8", "asset 1"],
            ["Character 9 - sprites", "asset 2"],
            ["Character 10", "conflict"],
            ["Character 10 - Different / eyes", "hazel"],
            ["Character 22 - New character / unknown42", "original"],
            ["Chaos", "Yes"],
            ["architecture 8", "arch"],
            ["unknown 8", "object"],
        ]);
        const characters = children(tree, "Characters");
        const drifs = children(characters, "Mini drif");
        expect(drifs.map((node) => [node.id, node.label])).toEqual([
            ["2", "Mini drif 1"],
            ["12", "Mini drif 2"],
        ]);
        expect(children(drifs, "Mini drif 1")[0]).toMatchObject({
            label: "Right",
            source: { key: "Character 2 - Mini drif / 7right" },
        });
        expect(
            children(drifs, "Mini drif 2").filter((n) => n.label === "Body"),
        ).toHaveLength(2);
        expect(
            children(children(characters, "M2main"), "M2main")[0],
        ).toMatchObject({ label: "Left wield" });
        expect(
            children(children(characters, "sprites"), "sprites 1")[0],
        ).toMatchObject({ label: "Artwork reference", value: "asset 1" });
        expect(
            children(children(characters, "sprites"), "sprites 2")[0],
        ).toMatchObject({ label: "Artwork reference", value: "asset 2" });
        expect(
            children(children(characters, "New character"), "New character")[0],
        ).toMatchObject({ label: "unknown42" });
        expect(
            children(
                children(tree, "Conflicting character names"),
                "Character 10",
            ),
        ).toHaveLength(2);
        expect(children(tree, "Other")).toHaveLength(1);
        expect(children(children(tree, "Scene"), "architecture")).toHaveLength(
            1,
        );
        expect(values.map((v) => v.fieldId)).toEqual([
            NFT111K_METADATA.CollectionBlock,
            "Chaos",
        ]);
    });

    it("pairs 1,447 title and artist slots with repeated titles and incomplete pairs", () => {
        const pairs: [string, string][] = [
            [NFT111K_METADATA.CollectionBlockAlias, STRUCTURED_BLOCK.Backrooms],
            ["Ceiling", "High"],
        ];
        for (let i = 1447; i >= 1; i--) {
            if (i !== 5) pairs.push(["Painting " + i, "Untitled"]);
            if (i !== 6)
                pairs.unshift(["Painting " + i + " Artist", "Artist " + i]);
        }
        const { tree, values } = project(STRUCTURED_BLOCK.Backrooms, pairs);
        const paintings = children(tree, "Paintings");
        expect(paintings).toHaveLength(1447);
        for (const slot of [1, 32, 1447]) {
            const instance = children(paintings, "Painting " + slot);
            expect(instance).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        label: "Title",
                        value: "Untitled",
                    }),
                    expect.objectContaining({
                        label: "Artist",
                        value: "Artist " + slot,
                    }),
                ]),
            );
        }
        expect(children(paintings, "Painting 5 · title unknown")).toHaveLength(
            1,
        );
        expect(children(paintings, "Painting 6 · artist unknown")).toHaveLength(
            1,
        );
        expect(values.map((v) => v.native)).toEqual([
            {
                key: NFT111K_METADATA.CollectionBlock,
                value: STRUCTURED_BLOCK.Backrooms,
            },
            { key: "Ceiling", value: "High" },
        ] satisfies TraitFilter[]);
        expect(children(tree, "Collection")).toHaveLength(1);
    });
});
