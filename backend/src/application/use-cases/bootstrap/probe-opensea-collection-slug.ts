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
    address?: string;
    slug?: string;
};

export type ProbeOpenSeaCollectionSlugOutput = {
    chain: ChainRecord;
    address: string | null;
    requestedSlug: string | null;
    status: BootstrapOpenSeaSlugProbeStatus;
    slug: string | null;
    reason: string | null;
};

// Outbound lookup boundary for OpenSea collection identity probing.
export interface OpenSeaCollectionSlugProbePort {
    resolveCollectionSlugByContract(input: {
        address: string;
    }): Promise<string | null>;
    resolveCollectionSlugBySlug(input: {
        slug: string;
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
        const address = input.address ? normalizeAddress(input.address) : null;
        const requestedSlug = input.slug ? normalizeSlug(input.slug) : null;
        if (address === null && requestedSlug === null) {
            throw new BootstrapValidationError(
                "Provide at least one OpenSea slug probe target",
            );
        }

        if (!this.openseaIntegration.enabled) {
            return {
                chain,
                address,
                requestedSlug,
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

        // Ask OpenSea for the collection identity attached to this probe target.
        let slug: string | null;
        if (address) {
            slug =
                await this.openSeaCollectionSlugProbePort.resolveCollectionSlugByContract(
                    {
                        address,
                    },
                );
        } else if (requestedSlug) {
            slug =
                await this.openSeaCollectionSlugProbePort.resolveCollectionSlugBySlug(
                    {
                        slug: requestedSlug,
                    },
                );
        } else {
            throw new BootstrapValidationError(
                "Provide at least one OpenSea slug probe target",
            );
        }
        if (requestedSlug && slug !== requestedSlug) {
            return {
                chain,
                address,
                requestedSlug,
                status: BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS.Missing,
                slug: null,
                reason: "OpenSea did not confirm this collection slug",
            };
        }
        if (!slug) {
            return {
                chain,
                address,
                requestedSlug,
                status: BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS.Missing,
                slug: null,
                reason: "OpenSea did not return a collection slug for this contract",
            };
        }

        return {
            chain,
            address,
            requestedSlug,
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

function normalizeSlug(raw: string): string {
    const value = raw.trim().toLowerCase();
    if (!value) {
        throw new BootstrapValidationError("Invalid OpenSea slug");
    }
    return value;
}
