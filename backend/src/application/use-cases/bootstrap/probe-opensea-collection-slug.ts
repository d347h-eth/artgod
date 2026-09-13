import type { ChainRecord } from "@artgod/shared/types/browse";
import type { OpenSeaIntegrationStatus } from "@artgod/shared/config/opensea-integration";
import {
    OPENSEA_COLLECTION_SLUG_PROBE_ERROR,
    OPENSEA_COLLECTION_SLUG_PROBE_STATUS,
    type OpenSeaCollectionSlugProbeStatus,
} from "@artgod/shared/opensea/collection-slug-probe";
import type { ChainRefResolverPort } from "./ports.js";
import { BootstrapValidationError } from "./types.js";

export type ProbeOpenSeaCollectionSlugInput = {
    chainRef: string;
    address: string;
    slug?: string;
    sampleTokenId?: string;
};

export type ProbeOpenSeaCollectionSlugOutput = {
    chain: ChainRecord;
    address: string | null;
    requestedSlug: string | null;
    status: OpenSeaCollectionSlugProbeStatus;
    slug: string | null;
    reason: string | null;
};

// Outbound lookup boundary for OpenSea collection identity probing.
export interface OpenSeaCollectionSlugProbePort {
    resolveVerifiedSlug(input: {
        address: string;
        requestedSlug: string | null;
        sampleTokenId: string;
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
        const requestedSlug = input.slug ? normalizeSlug(input.slug) : null;
        if (!this.openseaIntegration.enabled) {
            return {
                chain,
                address,
                requestedSlug,
                status: OPENSEA_COLLECTION_SLUG_PROBE_STATUS.Disabled,
                slug: null,
                reason:
                    this.openseaIntegration.reason ??
                    "OpenSea integration is disabled",
            };
        }
        if (!this.openSeaCollectionSlugProbePort) {
            throw new Error("OpenSea slug probe client is not configured");
        }

        const sampleTokenId = normalizeSampleTokenId(input.sampleTokenId);
        // Resolve through the metadata sample independently of the collection range.
        const slug =
            await this.openSeaCollectionSlugProbePort.resolveVerifiedSlug({
                address,
                requestedSlug,
                sampleTokenId,
            });
        if (requestedSlug && slug !== requestedSlug) {
            return {
                chain,
                address,
                requestedSlug,
                status: OPENSEA_COLLECTION_SLUG_PROBE_STATUS.Missing,
                slug: null,
                reason: "OpenSea did not confirm this collection slug",
            };
        }
        if (!slug) {
            return {
                chain,
                address,
                requestedSlug,
                status: OPENSEA_COLLECTION_SLUG_PROBE_STATUS.Missing,
                slug: null,
                reason: "OpenSea did not return a collection for this sample token. Check the sample token ID and try again.",
            };
        }

        return {
            chain,
            address,
            requestedSlug,
            status: OPENSEA_COLLECTION_SLUG_PROBE_STATUS.Found,
            slug,
            reason: null,
        };
    }
}

function normalizeAddress(raw: string): string {
    const value = raw?.trim().toLowerCase() ?? "";
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

function normalizeSampleTokenId(raw: string | undefined): string {
    const value = raw?.trim();
    if (!value)
        throw new BootstrapValidationError(
            OPENSEA_COLLECTION_SLUG_PROBE_ERROR.SampleRequired,
        );
    if (!/^\d+$/.test(value))
        throw new BootstrapValidationError(
            OPENSEA_COLLECTION_SLUG_PROBE_ERROR.SampleInvalid,
        );
    return BigInt(value).toString();
}
