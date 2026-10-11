import type { TraitFilter, TraitRangeFilter } from "../types/browse.js";
import {
    COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
    type CollectionBiddingTraitFilterJoinMode,
} from "../types/trading.js";
import {
    isTradingNumericTraitRange,
    normalizeTradingTraitText,
    type TradingBiddingTraitCriterion,
    type TradingTraitCriterion,
} from "../types/trading.js";

// Numeric marketplace metadata is decimal text; blank strings, hex and non-finite values
// must not become zero or otherwise satisfy a range.
export function numericTraitValue(value: string): number | null {
    if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))
        return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

export function biddingTraitValueMatches(
    criterion: TradingBiddingTraitCriterion,
    value: string,
): boolean {
    if (!isTradingNumericTraitRange(criterion))
        return criterion.value === value;
    const number = numericTraitValue(value);
    return (
        number !== null && number >= criterion.min && number <= criterion.max
    );
}

export function biddingTraitsMatchToken(
    criteria: readonly TradingBiddingTraitCriterion[],
    tokenTraits: readonly TradingTraitCriterion[],
): boolean {
    return criteria.every((criterion) =>
        tokenTraits.some(
            (trait) =>
                trait.type === criterion.type &&
                biddingTraitValueMatches(criterion, trait.value),
        ),
    );
}

// Complete, order-independent identity keeps range scopes distinct from exact job targets.
export function biddingTraitCriteriaKey(
    criteria: readonly TradingBiddingTraitCriterion[],
): string {
    return JSON.stringify(
        criteria
            .map((criterion) =>
                isTradingNumericTraitRange(criterion)
                    ? [criterion.type, criterion.min, criterion.max]
                    : [criterion.type, criterion.value],
            )
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    );
}

// Preserve criterion order and concrete types while removing only complete duplicates.
export function dedupeBiddingTraitCriteria<
    T extends TradingBiddingTraitCriterion,
>(criteria: readonly T[]): T[] {
    const seen = new Set<string>();
    return criteria.filter((criterion) => {
        const key = biddingTraitCriteriaKey([criterion]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// Validate the whole persisted scope: filtering out an invalid constraint would broaden it.
export function parseBiddingTraitCriteria(
    value: unknown,
): TradingBiddingTraitCriterion[] {
    if (!Array.isArray(value))
        throw new Error("Invalid bidding trait criteria");
    return value.map((entry): TradingBiddingTraitCriterion => {
        if (
            !entry ||
            typeof entry !== "object" ||
            typeof entry.type !== "string" ||
            !entry.type.trim()
        ) {
            throw new Error("Invalid bidding trait criterion");
        }
        const type = normalizeTradingTraitText(entry.type);
        if (
            typeof entry.value === "string" &&
            entry.min === undefined &&
            entry.max === undefined
        ) {
            return { type, value: normalizeTradingTraitText(entry.value) };
        }
        if (
            entry.value === undefined &&
            typeof entry.min === "number" &&
            Number.isFinite(entry.min) &&
            typeof entry.max === "number" &&
            Number.isFinite(entry.max) &&
            entry.min <= entry.max
        ) {
            return { type, min: entry.min, max: entry.max };
        }
        throw new Error("Invalid bidding trait criterion");
    });
}

// Scope filtering covers the whole trait combination in AND mode; OR mode
// includes any matching value or integer-range intersection. Shared by bid-book
// reads and the maintained UI fixture adapter.
export function biddingTraitScopeMatchesFilters(
    criteria: TradingBiddingTraitCriterion[],
    selectedTraits: TraitFilter[],
    selectedTraitRanges: TraitRangeFilter[],
    joinMode: CollectionBiddingTraitFilterJoinMode,
): boolean {
    if (selectedTraits.length === 0 && selectedTraitRanges.length === 0)
        return true;
    return joinMode === COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or
        ? traitScopeMatchesAnyFilter(
              criteria,
              selectedTraits,
              selectedTraitRanges,
          )
        : traitScopeMatchesAllFilters(
              criteria,
              selectedTraits,
              selectedTraitRanges,
          );
}

function traitScopeMatchesAllFilters(
    criteria: TradingBiddingTraitCriterion[],
    selectedTraits: TraitFilter[],
    selectedTraitRanges: TraitRangeFilter[],
): boolean {
    if (criteria.length === 0) {
        return false;
    }

    return (
        traitScopeCoveredByFilters(
            criteria,
            selectedTraits,
            selectedTraitRanges,
        ) &&
        filtersCoveredByTraitScope(
            criteria,
            selectedTraits,
            selectedTraitRanges,
        )
    );
}

function traitScopeCoveredByFilters(
    criteria: TradingBiddingTraitCriterion[],
    selectedTraits: TraitFilter[],
    selectedTraitRanges: TraitRangeFilter[],
): boolean {
    for (const criterion of criteria) {
        const sameTypeSelectedTraits = selectedTraits.filter(
            (trait) => trait.key === criterion.type,
        );
        const exactMatch =
            sameTypeSelectedTraits.length > 0 &&
            sameTypeSelectedTraits.some((trait) =>
                biddingTraitValueMatches(criterion, trait.value),
            );
        if (sameTypeSelectedTraits.length > 0) {
            if (!exactMatch) {
                return false;
            }
        }

        const range = selectedTraitRanges.find(
            (item) => item.key === criterion.type,
        );
        const rangeMatch = range
            ? traitCriterionIntersectsRange(criterion, range)
            : false;
        if (range && !rangeMatch) {
            return false;
        }

        if (!exactMatch && !rangeMatch) {
            return false;
        }
    }

    return true;
}

function filtersCoveredByTraitScope(
    criteria: TradingBiddingTraitCriterion[],
    selectedTraits: TraitFilter[],
    selectedTraitRanges: TraitRangeFilter[],
): boolean {
    const exactTraitsCovered = selectedTraits.every((trait) =>
        criteria.some(
            (criterion) =>
                criterion.type === trait.key &&
                biddingTraitValueMatches(criterion, trait.value),
        ),
    );
    if (!exactTraitsCovered) {
        return false;
    }

    return selectedTraitRanges.every((range) =>
        criteria.some(
            (criterion) =>
                criterion.type === range.key &&
                traitCriterionIntersectsRange(criterion, range),
        ),
    );
}

function traitScopeMatchesAnyFilter(
    criteria: TradingBiddingTraitCriterion[],
    selectedTraits: TraitFilter[],
    selectedTraitRanges: TraitRangeFilter[],
): boolean {
    if (criteria.length === 0) {
        return false;
    }

    return criteria.some(
        (criterion) =>
            selectedTraits.some(
                (trait) =>
                    trait.key === criterion.type &&
                    biddingTraitValueMatches(criterion, trait.value),
            ) ||
            selectedTraitRanges.some(
                (range) =>
                    range.key === criterion.type &&
                    traitCriterionIntersectsRange(criterion, range),
            ),
    );
}

// Browse filters use unsigned integer intervals. A marketplace interval matches
// only if their intersection contains an integer, preserving that filter contract.
function traitCriterionIntersectsRange(
    criterion: TradingBiddingTraitCriterion,
    range: TraitRangeFilter,
): boolean {
    if (isTradingNumericTraitRange(criterion)) {
        const first = BigInt(Math.ceil(criterion.min));
        const last = BigInt(Math.floor(criterion.max));
        return (
            first <= last &&
            (range.fromValue === null || last >= BigInt(range.fromValue)) &&
            (range.toValue === null || first <= BigInt(range.toValue)) &&
            last >= 0n
        );
    }
    return traitValueWithinRange(criterion.value, range);
}

function traitValueWithinRange(
    value: string,
    range: TraitRangeFilter,
): boolean {
    if (!/^\d+$/.test(value)) {
        return false;
    }
    const numeric = BigInt(value);
    if (range.fromValue !== null && numeric < BigInt(range.fromValue)) {
        return false;
    }
    if (range.toValue !== null && numeric > BigInt(range.toValue)) {
        return false;
    }
    return true;
}
