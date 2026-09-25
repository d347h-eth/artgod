import type { TraitTarget } from "./job.js";

// Broader trait offers compete for every NFT in the job's AND target. Keep this
// policy separate from exact target equality used to manage the maker's orders.
export function matchesTraitCompetition(
    criteria: readonly TraitTarget[],
    target: readonly TraitTarget[],
): boolean {
    return (
        target.length > 0 &&
        criteria.length > 0 &&
        criteria.every((criterion) =>
            target.some(
                (trait) =>
                    trait.type === criterion.type &&
                    trait.value === criterion.value,
            ),
        )
    );
}
