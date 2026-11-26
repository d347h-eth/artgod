import { describe, expect, it } from "vitest";
import { nft111kTraitCatalog as mapper } from "./111k-traits.js";
import { NFT111K_METADATA as meta } from "./111k-metadata.js";
import { resolveNativeTraitSelection } from "../types/trait-catalog.js";

describe("111K normalized collection views", () => {
    it.each(["egg", "crate", "warehouse", "relic"])(
        "pins only the native type for %s",
        (value) => {
            const scope = { key: meta.Type, value };
            expect(mapper.classify([scope])).toMatchObject({
                parent: null,
                pinnedTraits: [scope],
            });
        },
    );
    it("discovers an unseen block independently of artwork format or input order", () => {
        const scope = { key: meta.CollectionBlock, value: "Future: / block" };
        const view = mapper.classify([
            scope,
            { key: meta.Type, value: "video" },
        ]);
        expect(
            mapper.classify([{ key: meta.Type, value: "painting" }, scope]),
        ).toEqual(view);
        expect(view.pinnedTraits).toEqual([scope]);
        expect(
            mapper.classify([
                { ...scope, key: meta.CollectionBlockAlias },
                scope,
            ]),
        ).toEqual(view);
        expect(
            mapper.classify([{ key: meta.Type, value: "egg" }, scope])
                .pinnedTraits,
        ).toEqual([]);
        expect(
            mapper.classify([{ ...scope, value: "other" }, scope]).pinnedTraits,
        ).toEqual([]);
    });
    it("keeps every DriMi native criterion with its exact key and value", () => {
        const block = { key: meta.CollectionBlock, value: "DriMi" };
        const color = { key: "01 Background", value: "blue" };
        const facts = [
            block,
            color,
            { ...color, value: "red" },
            { key: "02 Shadow", value: "blue" },
        ];
        const view = mapper.classify(facts);
        const projection = mapper.project(
            view,
            mapper.availableVersion(view),
            facts,
        );
        expect(projection.values.map((item) => item.native)).toEqual(facts);
        expect(
            resolveNativeTraitSelection([...view.pinnedTraits, block, color]),
        ).toEqual([block, color]);
        expect(
            resolveNativeTraitSelection([...view.pinnedTraits, null]),
        ).toBeNull();
    });
});
