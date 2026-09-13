import { describe, expect, it, vi } from "vitest";
import { OpenSeaCollectionIdentityVerifier } from "./open-sea-collection-identity-verifier.js";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const SAMPLE = "2";
const SLUG = "sample-project";

describe("OpenSeaCollectionIdentityVerifier", () => {
    it.each([null, SLUG])(
        "identifies a sparse shared-contract collection using one sample (slug %s)",
        async (requestedSlug) => {
            const lookup = {
                resolveCollectionSlugByToken: vi.fn().mockResolvedValue(SLUG),
            };
            const verifier = new OpenSeaCollectionIdentityVerifier(lookup);
            await expect(
                verifier.resolveVerifiedSlug({
                    address: ADDRESS,
                    requestedSlug,
                    sampleTokenId: SAMPLE,
                }),
            ).resolves.toBe(SLUG);
            expect(
                lookup.resolveCollectionSlugByToken,
            ).toHaveBeenCalledExactlyOnceWith({
                address: ADDRESS,
                tokenId: SAMPLE,
            });
        },
    );

    it.each([null, "another-project"])(
        "rejects an absent or differently assigned sample (%s)",
        async (returnedSlug) => {
            const lookup = {
                resolveCollectionSlugByToken: vi
                    .fn()
                    .mockResolvedValue(returnedSlug),
            };
            await expect(
                new OpenSeaCollectionIdentityVerifier(
                    lookup,
                ).resolveVerifiedSlug({
                    address: ADDRESS,
                    requestedSlug: SLUG,
                    sampleTokenId: SAMPLE,
                }),
            ).resolves.toBeNull();
            expect(lookup.resolveCollectionSlugByToken).toHaveBeenCalledTimes(
                1,
            );
        },
    );

    it("propagates marketplace errors without retrying another token or contract identity", async () => {
        const failure = new Error("unavailable");
        const lookup = {
            resolveCollectionSlugByToken: vi.fn().mockRejectedValue(failure),
        };
        await expect(
            new OpenSeaCollectionIdentityVerifier(lookup).resolveVerifiedSlug({
                address: ADDRESS,
                requestedSlug: SLUG,
                sampleTokenId: SAMPLE,
            }),
        ).rejects.toBe(failure);
        expect(lookup.resolveCollectionSlugByToken).toHaveBeenCalledTimes(1);
    });
});
