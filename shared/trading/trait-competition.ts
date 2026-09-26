import type { TradingTraitCompetitionSelector } from "../types/trading.js";

// Bounds per-job matching work without expanding whole keys into their values.
export const MAX_EXTRA_COMPETITION_TRAITS = 64;

export class TraitCompetitionValidationError extends Error {}

// Owns validation and canonicalization at UI, API and persisted-state boundaries.
// Missing fields are handled by the caller: omission preserves, [] clears.
export function normalizeExtraCompetitionTraits(
    value: unknown,
): TradingTraitCompetitionSelector[] {
    if (!Array.isArray(value) || value.length > MAX_EXTRA_COMPETITION_TRAITS) {
        throw new TraitCompetitionValidationError(
            `Extra competitor traits must be a list of at most ${MAX_EXTRA_COMPETITION_TRAITS} entries.`,
        );
    }
    const selectors = value.map((entry): TradingTraitCompetitionSelector => {
        if (
            !entry ||
            typeof entry !== "object" ||
            Array.isArray(entry) ||
            typeof entry.type !== "string" ||
            !entry.type.trim() ||
            (entry.value !== undefined &&
                (typeof entry.value !== "string" || !entry.value.trim())) ||
            Object.keys(entry).some((key) => key !== "type" && key !== "value")
        ) {
            throw new TraitCompetitionValidationError(
                "Choose a trait key and either all values or a nonempty value.",
            );
        }
        return {
            type: entry.type.trim(),
            ...(entry.value === undefined ? {} : { value: entry.value.trim() }),
        };
    });
    const wholeKeys = new Set(
        selectors
            .filter((entry) => entry.value === undefined)
            .map((entry) => entry.type),
    );
    const unique = new Map<string, TradingTraitCompetitionSelector>();
    for (const selector of selectors) {
        if (selector.value !== undefined && wholeKeys.has(selector.type))
            continue;
        unique.set(
            JSON.stringify([selector.type, selector.value ?? null]),
            selector,
        );
    }
    return [...unique.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, selector]) => selector);
}
