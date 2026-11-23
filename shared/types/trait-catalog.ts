import type { TraitFilter } from "./browse.js";

export const TRAIT_CATALOG = {
    Canonical: "canonical",
    Derived: "derived",
} as const;
export type TraitCatalogKind =
    (typeof TRAIT_CATALOG)[keyof typeof TRAIT_CATALOG];
export const TRAIT_CATALOG_QUERY = {
    View: "view",
    Catalog: "trait_catalog",
    Generation: "generation",
} as const;

/** A null view is valid for explicit canonical reads on ordinary collections. */
export type TraitReadContext = {
    viewId: string | null;
    catalog: TraitCatalogKind;
    generation: number | null;
};

export type CollectionViewDescriptor = {
    id: string;
    label: string;
    parent: { id: string; label: string } | null;
    /** Empty for an unresolved classification which cannot scope a native bid. */
    pinnedTraits: TraitFilter[];
};
export type CollectionViewStatus = CollectionViewDescriptor & {
    generation: number;
    activeMapperVersion: string;
    availableMapperVersion: string;
    classified: number;
    ready: number;
    latestRun?: TraitCatalogRebuild | null;
};
export type CollectionViewsResponse = {
    required: boolean;
    selectedViewId: string | null;
    views: CollectionViewStatus[];
};

export const TRAIT_CATALOG_REBUILD_STATUS = {
    Running: "running",
    Failed: "failed",
    Completed: "completed",
} as const;
export type TraitCatalogRebuild = {
    runId: number;
    generation: number;
    viewId: string;
    mapperVersion: string;
    status: (typeof TRAIT_CATALOG_REBUILD_STATUS)[keyof typeof TRAIT_CATALOG_REBUILD_STATUS];
    processed: number;
    total: number;
    error: string | null;
};

export type TraitNode =
    | {
          kind: "group" | "entity";
          id: string;
          label: string;
          children: TraitNode[];
      }
    | {
          kind: "leaf";
          id: string;
          label: string;
          value: string;
          source: TraitFilter;
      };
/** Only flat, filterable leaves appear here. Native targeting requires an exact binding. */
export type ProjectedTraitValue = {
    fieldId: string;
    label: string;
    value: string;
    native: TraitFilter | null;
};
export type TraitProjection = {
    tree: TraitNode[];
    values: ProjectedTraitValue[];
};
export interface TraitCatalogMapper {
    classify(pairs: readonly TraitFilter[]): CollectionViewDescriptor;
    availableVersion(view: CollectionViewDescriptor): string;
    project(
        view: CollectionViewDescriptor,
        version: string,
        pairs: readonly TraitFilter[],
    ): TraitProjection;
}

/** A partial native target would widen the requested offer. Preserve every selected criterion. */
export function resolveNativeTraitSelection(
    bindings: readonly (TraitFilter | null)[],
): TraitFilter[] | null {
    const unique = new Map<string, TraitFilter>();
    for (const binding of bindings) {
        if (!binding) return null;
        unique.set(JSON.stringify([binding.key, binding.value]), binding);
    }
    return [...unique.values()];
}
