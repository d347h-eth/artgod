import { describe, it, expect } from "vitest";
import type {
    ChainRecord,
    CollectionListItem,
    TradingCompetitionPreset,
} from "@artgod/shared/types";
import {
    BiddingCompetitionPresetsUseCase,
    type CompetitionPresetDefinition,
} from "./bidding-competition-presets.js";
import { TradingValidationError } from "./types.js";

const CHAIN: ChainRecord = {
    id: 1,
    type: "evm",
    publicChainId: 1,
    slug: "ethereum",
    name: "Ethereum",
};
const COLLECTION = {
    chainId: 1,
    collectionId: 7,
    slug: "fixture",
} as CollectionListItem;
const BASE = {
    chainRef: "ethereum",
    collectionRef: "fixture",
    targetTraits: [{ type: "Zone", value: "Kairo" }],
    extraCompetitionTraits: [{ type: "Mode" }],
};

function fixture() {
    const writes: CompetitionPresetDefinition[] = [];
    const catalogReads: unknown[] = [];
    const archives: unknown[] = [];
    const saved: TradingCompetitionPreset = {
        presetId: "preset",
        versionId: "version",
        revision: 1,
        targetTraits: BASE.targetTraits,
        extraCompetitionTraits: BASE.extraCompetitionTraits,
        archivedAt: null,
    };
    const useCase = new BiddingCompetitionPresetsUseCase(
        1,
        { resolveChainRef: () => CHAIN },
        { resolveCollectionRef: () => COLLECTION },
        {
            listMarketplaceBiddingSupportedTraits: (input) =>
                input.traits.filter(
                    (t) => t.key === "Zone" && t.value === "Kairo",
                ),
        },
        {
            listCollectionTraitCatalog: (input) => {
                catalogReads.push(input);
                return [
                    {
                        key: "Mode",
                        values: [{ value: "Terrain" }, { value: "Daydream" }],
                    },
                ];
            },
        },
        {
            listPresets: () => [saved],
            savePreset: (input) => {
                writes.push(input);
                return saved;
            },
            archivePreset: (input) => {
                archives.push(input);
            },
        },
    );
    return { useCase, writes, catalogReads, archives };
}

describe("competitive extras presets", () => {
    it("canonicalizes inventory selectors and reads their unfiltered collection catalog", () => {
        const f = fixture();
        f.useCase.upsertCompetitionPreset({
            ...BASE,
            extraCompetitionTraits: [
                { type: " Mode ", value: " Terrain " },
                { type: "Mode" },
            ],
        });
        expect(f.writes[0]).toMatchObject({
            chainId: 1,
            collectionId: 7,
            targetTraits: BASE.targetTraits,
            extraCompetitionTraits: [{ type: "Mode" }],
        });
        expect(f.catalogReads).toEqual([
            { chainId: 1, collectionId: 7, keys: ["Mode"] },
        ]);
    });
    it("rejects unsupported targets, unknown extras and empty definitions before writing", () => {
        const f = fixture();
        for (const input of [
            { ...BASE, targetTraits: [] },
            { ...BASE, targetTraits: [{ type: "Mode", value: "Terrain" }] },
            { ...BASE, extraCompetitionTraits: [] },
            {
                ...BASE,
                extraCompetitionTraits: [{ type: "Mode", value: "typo" }],
            },
            { ...BASE, extraCompetitionTraits: [{ type: "typo" }] },
        ])
            expect(() => f.useCase.upsertCompetitionPreset(input)).toThrow(
                TradingValidationError,
            );
        expect(f.writes).toEqual([]);
    });
    it("scopes archive and preserves its optimistic revision", () => {
        const f = fixture();
        f.useCase.archiveCompetitionPreset({
            ...BASE,
            presetId: "preset",
            expectedRevision: 2,
        });
        expect(f.archives).toEqual([
            {
                chainId: 1,
                collectionId: 7,
                presetId: "preset",
                expectedRevision: 2,
            },
        ]);
    });
});
