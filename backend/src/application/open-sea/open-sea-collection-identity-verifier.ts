import { OPENSEA_COLLECTION_SLUG_PROBE_MAX_VERIFICATION_TOKEN_IDS } from "@artgod/shared/opensea/collection-slug-probe";

// OpenSea collection identity returned by the marketplace lookup boundary.
export type OpenSeaCollectionIdentity = {
    slug: string;
    contractAddresses: readonly string[];
};

// Marketplace lookups required to bind a slug to a contract and representative tokens.
export interface OpenSeaCollectionIdentityLookupPort {
    resolveCollectionSlugByContract(input: {
        address: string;
    }): Promise<string | null>;
    resolveCollectionBySlug(input: {
        slug: string;
    }): Promise<OpenSeaCollectionIdentity | null>;
    resolveCollectionSlugByToken(input: {
        address: string;
        tokenId: string;
    }): Promise<string | null>;
}

export type ResolveOpenSeaCollectionIdentityInput = {
    address: string | null;
    requestedSlug: string | null;
    verificationTokenIds: readonly string[];
};

// Resolves and verifies one OpenSea collection identity without trusting shared-contract defaults.
export class OpenSeaCollectionIdentityVerifier {
    constructor(
        private readonly lookupPort: OpenSeaCollectionIdentityLookupPort,
    ) {}

    async resolveVerifiedSlug(
        input: ResolveOpenSeaCollectionIdentityInput,
    ): Promise<string | null> {
        const address = normalizeAddress(input.address);
        const tokenIds = normalizeVerificationTokenIds(
            input.verificationTokenIds,
        );
        if (
            tokenIds.length >
            OPENSEA_COLLECTION_SLUG_PROBE_MAX_VERIFICATION_TOKEN_IDS
        ) {
            throw new Error(
                "OpenSea collection identity verification accepts at most two token IDs",
            );
        }

        // Resolve a candidate from the requested slug, a representative token, or the contract.
        const resolvedTokenSlugs = new Map<string, string | null>();
        const candidateSlug =
            normalizeSlug(input.requestedSlug) ??
            (await this.resolveCandidateSlug(
                address,
                tokenIds,
                resolvedTokenSlugs,
            ));
        if (!candidateSlug) return null;

        // Confirm the canonical collection record and contract membership first.
        const collection = await this.lookupPort.resolveCollectionBySlug({
            slug: candidateSlug,
        });
        if (!collection || collection.slug !== candidateSlug) return null;
        if (address && !collection.contractAddresses.includes(address)) {
            return null;
        }

        // Bind shared-contract collections to the representative tokens in ArtGod's scope.
        if (tokenIds.length > 0) {
            if (!address) return null;
            for (const tokenId of tokenIds) {
                const tokenSlug = resolvedTokenSlugs.has(tokenId)
                    ? (resolvedTokenSlugs.get(tokenId) ?? null)
                    : await this.lookupPort.resolveCollectionSlugByToken({
                          address,
                          tokenId,
                      });
                if (tokenSlug !== candidateSlug) return null;
            }
        }
        return candidateSlug;
    }

    private async resolveCandidateSlug(
        address: string | null,
        tokenIds: readonly string[],
        resolvedTokenSlugs: Map<string, string | null>,
    ): Promise<string | null> {
        if (!address) return null;
        const firstTokenId = tokenIds[0];
        if (firstTokenId) {
            const slug = await this.lookupPort.resolveCollectionSlugByToken({
                address,
                tokenId: firstTokenId,
            });
            resolvedTokenSlugs.set(firstTokenId, slug);
            return slug;
        }
        return this.lookupPort.resolveCollectionSlugByContract({ address });
    }
}

function normalizeSlug(value: string | null): string | null {
    if (value === null) return null;
    const slug = value.trim().toLowerCase();
    return slug || null;
}

function normalizeAddress(value: string | null): string | null {
    if (value === null) return null;
    const address = value.trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(address)) {
        throw new Error("OpenSea collection identity address is invalid");
    }
    return address;
}

function normalizeVerificationTokenIds(tokenIds: readonly string[]): string[] {
    return [...new Set(tokenIds.map(normalizeTokenId))];
}

function normalizeTokenId(value: string): string {
    const tokenId = value.trim();
    if (!/^\d+$/.test(tokenId)) {
        throw new Error("OpenSea collection identity token ID must be decimal");
    }
    return BigInt(tokenId).toString();
}
