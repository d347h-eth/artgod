import type { OpenSeaContractLookupPort } from "@artgod/shared/network/opensea-contract-lookup";
import {
    BOOTSTRAP_OUTPUT_STEP,
    type BootstrapOutputReporter,
} from "@artgod/shared/bootstrap/operation-output";
import { bootstrapResourceObserver } from "./resource-output.js";
import type { OpenSeaCollectionIdentityLookupPort } from "../../application/open-sea/open-sea-collection-identity-verifier.js";

// Adapts shared OpenSea REST lookups to the backend collection identity boundary.
export class OpenSeaCollectionSlugProbeAdapter implements OpenSeaCollectionIdentityLookupPort {
    constructor(
        private readonly contractLookup: Pick<
            OpenSeaContractLookupPort,
            "resolveCollectionByToken"
        >,
    ) {}

    async resolveCollectionSlugByToken(
        input: {
            address: string;
            tokenId: string;
        },
        report?: BootstrapOutputReporter,
    ): Promise<string | null> {
        const collection = await this.contractLookup.resolveCollectionByToken(
            {
                address: input.address,
                tokenId: input.tokenId,
            },
            bootstrapResourceObserver(report, BOOTSTRAP_OUTPUT_STEP.OpenSea),
        );
        return collection?.slug ?? null;
    }
}
