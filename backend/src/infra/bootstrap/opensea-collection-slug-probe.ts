import type { OpenSeaContractLookupPort } from "@artgod/shared/network/opensea-contract-lookup";
import type { OpenSeaCollectionIdentityLookupPort } from "../../application/open-sea/open-sea-collection-identity-verifier.js";

// Adapts shared OpenSea REST lookups to the backend collection identity boundary.
export class OpenSeaCollectionSlugProbeAdapter implements OpenSeaCollectionIdentityLookupPort {
    constructor(
        private readonly contractLookup: Pick<
            OpenSeaContractLookupPort,
            "resolveCollectionByToken"
        >,
    ) {}

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
