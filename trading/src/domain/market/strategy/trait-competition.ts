import type { TraitTarget, TraitSelector } from "./job.js";

// Broader trait offers compete for every NFT in the job's AND target. Keep this
// policy separate from exact target equality used to manage the maker's orders.
export function matchesTraitCompetition(
    criteria: readonly TraitTarget[],
    target: readonly TraitTarget[],
    extras: readonly TraitSelector[] = [],
): boolean {
    if (target.length === 0 || criteria.length === 0) return false;
    if (
        criteria.every((criterion) =>
            target.some(
                (trait) =>
                    trait.type === criterion.type &&
                    trait.value === criterion.value,
            ),
        )
    )
        return true;

    // Extra selectors include standalone buckets only. Repeated copies of the
    // same criterion do not turn a single-trait offer into a multi-trait offer.
    const first = criteria[0];
    return (
        criteria.every(
            (trait) => trait.type === first.type && trait.value === first.value,
        ) &&
        extras.some(
            (selector) =>
                selector.type === first.type &&
                (selector.value === undefined ||
                    selector.value === first.value),
        )
    );
}
