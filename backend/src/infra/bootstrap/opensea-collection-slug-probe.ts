import type { OpenSeaContractLookupPort } from "@artgod/shared/network/opensea-contract-lookup";
import type { OpenSeaCollectionIdentityLookupPort } from "../../application/open-sea/open-sea-collection-identity-verifier.js";

// Adapts shared OpenSea REST lookups to the backend collection identity boundary.
export class OpenSeaCollectionSlugProbeAdapter implements OpenSeaCollectionIdentityLookupPort {
    constructor(private readonly contractLookup: OpenSeaContractLookupPort) {}

    async resolveCollectionSlugByContract(input: {
        address: string;
    }): Promise<string | null> {
        const collection =
            await this.contractLookup.resolveCollectionByContract({
                address: input.address,
            });
        return collection?.slug ?? null;
    }

    async resolveCollectionBySlug(input: { slug: string }): Promise<{
        slug: string;
        contractAddresses: readonly string[];
    } | null> {
        const collection = await this.contractLookup.resolveCollectionBySlug({
            slug: input.slug,
        });
        return collection;
    }

    async resolveCollectionSlugByToken(input: {
        address: string;
        tokenId: string;
    }): Promise<string | null> {
        const collection = await this.contractLookup.resolveCollectionByToken({
            address: input.address,
            tokenId: input.tokenId,
        });
        return collection?.slug ?? null;
    }
}
