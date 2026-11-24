import type { TraitFilter } from "./browse.js";

export const TRAIT_CATALOG = {
    Canonical: "canonical",
    Derived: "derived",
} as const;
export type TraitCatalogKind =
    (typeof TRAIT_CATALOG)[keyof typeof TRAIT_CATALOG];
export const TRAIT_CATALOG_QUERY = {
    View: "view",
    Group: "view_group",
    Catalog: "trait_catalog",
    Generation: "generation",
} as const;

/** Collections and parent groups use canonical facts. A leaf can pin a projection generation. */
export type TraitReadContext = {
    viewId: string | null;
    groupId?: string;
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
    /** Current members with a classifier or active projection error. */
    failed?: number;
    latestRun?: TraitCatalogRebuild | null;
};
export type CollectionViewsResponse = {
    required: boolean;
    selectedViewId: string | null;
    selectedGroupId?: string;
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

export const TRAIT_NODE_KIND = {
    Group: "group",
    Entity: "entity",
    Leaf: "leaf",
} as const;
export type TraitNode =
    | {
          kind: typeof TRAIT_NODE_KIND.Group | typeof TRAIT_NODE_KIND.Entity;
          id: string;
          label: string;
          children: TraitNode[];
      }
    | {
          kind: typeof TRAIT_NODE_KIND.Leaf;
          id: string;
          label: string;
          value: string;
          fieldId?: string;
          source: TraitFilter;
      };
/** Only flat, filterable leaves appear here. Native targeting requires an exact binding. */
export type ProjectedTraitValue = {
    fieldId: string;
    label: string;
    value: string;
    native: TraitFilter | null;
    /** An explicit declaration that the entire canonical key retains its meaning. */
    nativeFieldKey?: string;
};
export type TraitProjection = {
    tree: TraitNode[];
    values: ProjectedTraitValue[];
};
export interface TraitCatalogMapper {
    unclassified: CollectionViewDescriptor;
    /** Canonical keys to offer in the collection and parent-group filter sidebar. */
    aggregateFacetKeys: readonly string[];
    classify(pairs: readonly TraitFilter[]): CollectionViewDescriptor;
    /** Ordered, equivalent native keys for a single pinned value. Discovery tests
     * these exact alternatives only when members prefer different source spellings. */
    equivalentPinKeys?(view: CollectionViewDescriptor): readonly string[];
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

/** Local evidence for a marketplace offer's applicability to a selected collection view. */
export const VIEW_OFFER_APPLICABILITY = {
    Matched: "matched",
    Unresolved: "unresolved",
} as const;
export type ViewOfferApplicability =
    (typeof VIEW_OFFER_APPLICABILITY)[keyof typeof VIEW_OFFER_APPLICABILITY];

/** Reverse only one-to-one declared bindings. A shared display label cannot establish eligibility. */
export function createNativeTraitPresentation(
    fields: readonly {
        key: string;
        nativeKey?: string | null;
        values: readonly { value: string; native?: TraitFilter | null }[];
    }[],
) {
    const keys = new Map<string, string | null>();
    const values = new Map<string, TraitFilter | null>();
    for (const field of fields) {
        if (field.nativeKey) {
            const prior = keys.get(field.nativeKey);
            keys.set(
                field.nativeKey,
                prior === undefined || prior === field.key ? field.key : null,
            );
        }
        for (const { value, native } of field.values) {
            if (!native) continue;
            const signature = JSON.stringify([native.key, native.value]);
            const prior = values.get(signature);
            const unambiguous =
                prior === undefined ||
                (prior?.key === field.key && prior.value === value);
            values.set(
                signature,
                unambiguous ? { key: field.key, value } : null,
            );
        }
    }
    return {
        key: (nativeKey: string) => keys.get(nativeKey) ?? null,
        value: (native: TraitFilter) =>
            values.get(JSON.stringify([native.key, native.value])) ?? null,
    };
}

/** Translate a view's pinned criteria and ordinary facet choices as a single native target. */
export function resolveEffectiveNativeTraits(input: {
    catalog: TraitCatalogKind;
    /** Omit for the whole collection. An empty pin list on a leaf means its scope is unresolved. */
    pinned?: readonly TraitFilter[];
    traits: readonly TraitFilter[];
    facets: readonly {
        key: string;
        values: readonly {
            value: string;
            native?: TraitFilter | null;
            marketplaceBiddingSupported?: boolean;
        }[];
    }[];
}): TraitFilter[] | null {
    if (
        input.pinned?.length === 0 ||
        (!input.pinned && input.catalog !== TRAIT_CATALOG.Canonical)
    )
        return null;
    const facets = new Map(input.facets.map((facet) => [facet.key, facet]));
    const bindings = input.traits.map((trait) => {
        const pin = input.pinned?.find((scope) => scope.key === trait.key);
        if (pin) return pin.value === trait.value ? pin : null;
        const facetValue = facets
            .get(trait.key)
            ?.values.find((item) => item.value === trait.value);
        if (input.catalog === TRAIT_CATALOG.Canonical)
            return input.pinned || facetValue?.marketplaceBiddingSupported
                ? trait
                : null;
        return facetValue?.native ?? null;
    });
    return resolveNativeTraitSelection([...(input.pinned ?? []), ...bindings]);
}
