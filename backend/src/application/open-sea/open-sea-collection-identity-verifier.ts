// Marketplace lookup needed to identify a collection through one known token.
export interface OpenSeaCollectionIdentityLookupPort {
    resolveCollectionSlugByToken(input: {
        address: string;
        tokenId: string;
    }): Promise<string | null>;
}

// The sample identifies the collection; scope boundaries do not prove minting.
export type ResolveOpenSeaCollectionIdentityInput = {
    address: string;
    requestedSlug: string | null;
    sampleTokenId: string;
};

// Verifies a slug with exactly one NFT lookup, including on shared contracts.
export class OpenSeaCollectionIdentityVerifier {
    constructor(
        private readonly lookupPort: OpenSeaCollectionIdentityLookupPort,
    ) {}

    async resolveVerifiedSlug(
        input: ResolveOpenSeaCollectionIdentityInput,
    ): Promise<string | null> {
        // Bind the exact contract and sample to OpenSea's collection slug.
        const slug = await this.lookupPort.resolveCollectionSlugByToken({
            address: input.address,
            tokenId: input.sampleTokenId,
        });
        if (
            !slug ||
            (input.requestedSlug !== null && slug !== input.requestedSlug)
        )
            return null;
        return slug;
    }
}
