import type { ChainRecord } from "@artgod/shared/types/browse";
import type { OpenSeaIntegrationStatus } from "@artgod/shared/config/opensea-integration";
import {
    BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS,
    type BootstrapOpenSeaSlugProbeStatus,
} from "@artgod/shared/bootstrap/opensea-slug-probe";
import type { ChainRefResolverPort } from "./ports.js";
import { BootstrapValidationError } from "./types.js";

export type ProbeOpenSeaCollectionSlugInput = {
    chainRef: string;
    address: string;
};

export type ProbeOpenSeaCollectionSlugOutput = {
    chain: ChainRecord;
    address: string;
    status: BootstrapOpenSeaSlugProbeStatus;
    slug: string | null;
    reason: string | null;
};

// Outbound lookup boundary for OpenSea contract identity probing.
export interface OpenSeaCollectionSlugProbePort {
    resolveCollectionSlugByContract(input: {
        address: string;
    }): Promise<string | null>;
}

export class ProbeOpenSeaCollectionSlugUseCase {
    constructor(
        private readonly defaultChainId: number,
        private readonly openseaIntegration: OpenSeaIntegrationStatus,
        private readonly chainRefResolverPort: ChainRefResolverPort,
        private readonly openSeaCollectionSlugProbePort: OpenSeaCollectionSlugProbePort | null,
    ) {}

    async probe(
        input: ProbeOpenSeaCollectionSlugInput,
    ): Promise<ProbeOpenSeaCollectionSlugOutput> {
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        const address = normalizeAddress(input.address);

        if (!this.openseaIntegration.enabled) {
            return {
                chain,
                address,
                status: BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS.Disabled,
                slug: null,
                reason:
                    this.openseaIntegration.reason ??
                    "OpenSea integration is disabled",
            };
        }
        if (!this.openSeaCollectionSlugProbePort) {
            throw new Error("OpenSea slug probe client is not configured");
        }

        // Ask OpenSea for the collection identity attached to this contract.
        const slug =
            await this.openSeaCollectionSlugProbePort.resolveCollectionSlugByContract(
                {
                    address,
                },
            );
        if (!slug) {
            return {
                chain,
                address,
                status: BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS.Missing,
                slug: null,
                reason: "OpenSea did not return a collection slug for this contract",
            };
        }

        return {
            chain,
            address,
            status: BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS.Found,
            slug,
            reason: null,
        };
    }
}

function normalizeAddress(raw: string): string {
    const value = raw.trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(value)) {
        throw new BootstrapValidationError("Invalid address");
    }
    return value;
}
