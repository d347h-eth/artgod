import {
    BOOTSTRAP_OUTPUT_STEP as Step,
    BOOTSTRAP_OUTPUT_STATUS as Status,
    type BootstrapOutputReporter,
} from "@artgod/shared/bootstrap/operation-output";
// Marketplace lookup needed to identify a collection through one known token.
export interface OpenSeaCollectionIdentityLookupPort {
    resolveCollectionSlugByToken(
        input: {
            address: string;
            tokenId: string;
        },
        report?: BootstrapOutputReporter,
    ): Promise<string | null>;
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
        report?: BootstrapOutputReporter,
    ): Promise<string | null> {
        // Bind the exact contract and sample to OpenSea's collection slug.
        const slug = await this.lookupPort.resolveCollectionSlugByToken(
            {
                address: input.address,
                tokenId: input.sampleTokenId,
            },
            report,
        );
        report?.({
            step: Step.OpenSea,
            status: slug ? Status.Succeeded : Status.Failed,
            message: slug
                ? `Token #${input.sampleTokenId} belongs to OpenSea collection: ${slug}`
                : `No OpenSea collection returned for token #${input.sampleTokenId}. Choose another sample and press resolve.`,
        });
        if (input.requestedSlug !== null)
            report?.({
                step: Step.OpenSea,
                status:
                    slug === input.requestedSlug
                        ? Status.Succeeded
                        : Status.Failed,
                message:
                    slug === input.requestedSlug
                        ? `Requested slug confirmed: ${input.requestedSlug}`
                        : `Requested slug "${input.requestedSlug}" does not match "${slug ?? "no collection"}". Correct the slug or sample and press resolve.`,
            });
        if (
            !slug ||
            (input.requestedSlug !== null && slug !== input.requestedSlug)
        )
            return null;
        return slug;
    }
}
