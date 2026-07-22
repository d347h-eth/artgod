import type { ChainRecord } from "@artgod/shared/types/browse";
import type { OpenSeaIntegrationStatus } from "@artgod/shared/config/opensea-integration";
import {
    OPENSEA_COLLECTION_SLUG_PROBE_MAX_VERIFICATION_TOKEN_IDS,
    OPENSEA_COLLECTION_SLUG_PROBE_STATUS,
    type OpenSeaCollectionSlugProbeStatus,
} from "@artgod/shared/opensea/collection-slug-probe";
import type { ChainRefResolverPort } from "./ports.js";
import { BootstrapValidationError } from "./types.js";

export type ProbeOpenSeaCollectionSlugInput = {
    chainRef: string;
    address?: string;
    slug?: string;
    verificationTokenIds?: string[];
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
        address: string | null;
        requestedSlug: string | null;
        verificationTokenIds: readonly string[];
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
        const verificationTokenIds = normalizeVerificationTokenIds(
            input.verificationTokenIds ?? [],
        );
        if (address === null && requestedSlug === null) {
            throw new BootstrapValidationError(
                "Provide at least one OpenSea slug probe target",
            );
        }
        if (address === null && verificationTokenIds.length > 0) {
            throw new BootstrapValidationError(
                "OpenSea verification token IDs require a contract address",
            );
        }

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

        // Resolve the slug and bind shared contracts to representative scope tokens.
        const slug =
            await this.openSeaCollectionSlugProbePort.resolveVerifiedSlug({
                address,
                requestedSlug,
                verificationTokenIds,
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
                reason: "OpenSea did not return a collection slug for this contract",
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

function normalizeVerificationTokenIds(tokenIds: readonly string[]): string[] {
    if (
        tokenIds.length >
        OPENSEA_COLLECTION_SLUG_PROBE_MAX_VERIFICATION_TOKEN_IDS
    ) {
        throw new BootstrapValidationError(
            "OpenSea slug verification accepts at most the first and last token IDs",
        );
    }
    return tokenIds.map((raw) => {
        const value = raw.trim();
        if (!/^\d+$/.test(value)) {
            throw new BootstrapValidationError(
                "OpenSea verification token IDs must be decimal",
            );
        }
        return value;
    });
}
