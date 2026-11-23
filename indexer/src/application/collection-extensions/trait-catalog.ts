import type { TraitFilter } from "@artgod/shared/types/browse";
import type {
    CollectionViewDescriptor,
    TraitCatalogMapper,
    TraitProjection,
} from "@artgod/shared/types/trait-catalog";
import type { CollectionExtensionInstallPort } from "../../ports/collection-extensions.js";
import { resolveIndexerCollectionExtension } from "./index.js";

export type CatalogToken = {
    chainId: number;
    collectionId: number;
    tokenId: string;
};
export type CatalogMapperResolver = (
    chainId: number,
    collectionId: number,
) => TraitCatalogMapper | null;

export function installedCatalogMapper(
    installs: Pick<CollectionExtensionInstallPort, "getInstall">,
): CatalogMapperResolver {
    return (chainId, collectionId) => {
        const install = installs.getInstall(chainId, collectionId);
        return install?.enabled
            ? (resolveIndexerCollectionExtension(install)?.traitCatalog ?? null)
            : null;
    };
}

export type ProjectionClaim = CatalogToken & {
    revision: number;
    generation: number;
    view: CollectionViewDescriptor;
    mapperVersion: string;
    owner: string;
    traits: TraitFilter[];
};

/** Receives the exact pairs just persisted, within the canonical observation transaction. */
export interface CanonicalTraitCatalogSink {
    replaceCanonical(token: CatalogToken, traits: readonly TraitFilter[]): void;
}

export interface TraitProjectionStore {
    cleanupRetired(chainId: number): boolean;
    retryClassification(chainId: number, now: number): boolean;
    advanceRebuild(chainId: number): boolean;
    claim(chainId: number, now: number): ProjectionClaim | null;
    finish(claim: ProjectionClaim, projection: TraitProjection): void;
    fail(claim: ProjectionClaim, error: string, now: number): void;
}

/** One bounded unit of local work. A crashed process leaves a reclaimable revision-fenced lease. */
export function advanceTraitCatalog(
    chainId: number,
    store: TraitProjectionStore,
    resolve: CatalogMapperResolver,
    now = Date.now(),
): boolean {
    const cleaned = store.cleanupRetired(chainId);
    const classified = store.retryClassification(chainId, now);
    const scheduled = store.advanceRebuild(chainId);
    const claim = store.claim(chainId, now);
    if (!claim) return classified || scheduled || cleaned;
    const mapper = resolve(chainId, claim.collectionId);
    if (!mapper) return true;
    try {
        const projection = mapper.project(
            claim.view,
            claim.mapperVersion,
            claim.traits,
        );
        store.finish(claim, projection);
    } catch (error) {
        store.fail(claim, String(error), now);
    }
    return true;
}
