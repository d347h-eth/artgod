import { describe, expect, it, vi } from "vitest";
import { OpenSeaCollectionSlugProbeAdapter } from "./opensea-collection-slug-probe.js";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const SAMPLE = "2";
const SLUG = "shared-project";

describe("OpenSeaCollectionSlugProbeAdapter", () => {
    it.each([{ slug: SLUG }, null])(
        "maps the one-token result %j",
        async (collection) => {
            const lookup = {
                resolveCollectionByToken: vi.fn().mockResolvedValue(collection),
            };
            await expect(
                new OpenSeaCollectionSlugProbeAdapter(
                    lookup,
                ).resolveCollectionSlugByToken({
                    address: ADDRESS,
                    tokenId: SAMPLE,
                }),
            ).resolves.toBe(collection?.slug ?? null);
            expect(
                lookup.resolveCollectionByToken,
            ).toHaveBeenCalledExactlyOnceWith({
                address: ADDRESS,
                tokenId: SAMPLE,
            });
        },
    );
});
