import type { OpenSeaContractLookupPort } from "@artgod/shared/network/opensea-contract-lookup";
import type { OpenSeaCollectionSlugProbePort } from "../../application/use-cases/bootstrap/probe-opensea-collection-slug.js";

// Adapts shared OpenSea contract lookup results to bootstrap slug probing.
export class OpenSeaCollectionSlugProbeAdapter implements OpenSeaCollectionSlugProbePort {
    constructor(private readonly contractLookup: OpenSeaContractLookupPort) {}

    async resolveCollectionSlugByContract(input: {
        address: string;
    }): Promise<string | null> {
        const collection = await this.contractLookup.resolveCollectionByContract({
            address: input.address,
        });
        return collection?.slug ?? null;
    }
}
