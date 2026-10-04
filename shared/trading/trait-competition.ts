import {
    normalizeTradingTraitCriteria,
    type TradingTraitCriterion,
    type TradingCompetitionPresetVersion,
    type TradingTraitCompetitionSelector,
} from "../types/trading.js";

// Bounds per-job matching work without expanding whole keys into their values.
export const MAX_EXTRA_COMPETITION_TRAITS = 64;
// Preset sources mirror the supported one- or two-trait selection UI.
export const MAX_COMPETITION_PRESET_TARGET_TRAITS = 2;

export class TraitCompetitionValidationError extends Error {}

// Owns validation and canonicalization at UI, API and persisted-state boundaries.
// Used for preset definitions and the resolved strategy input.
export function normalizeExtraCompetitionTraits(
    value: unknown,
): TradingTraitCompetitionSelector[] {
    if (!Array.isArray(value) || value.length > MAX_EXTRA_COMPETITION_TRAITS) {
        throw new TraitCompetitionValidationError(
            `Extra targets must be a list of at most ${MAX_EXTRA_COMPETITION_TRAITS} entries.`,
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

// Concrete marketplace bids always target explicit values in an AND combination.
export function normalizeTraitBiddingTarget(
    value: unknown,
): TradingTraitCriterion[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new TraitCompetitionValidationError("targetTraits is required");
    }
    const traits = value.map((entry) => {
        if (!entry || typeof entry.type !== "string" || !entry.type.trim()) {
            throw new TraitCompetitionValidationError(
                "targetTraits.type is required",
            );
        }
        if (typeof entry.value !== "string" || !entry.value.trim()) {
            throw new TraitCompetitionValidationError(
                "targetTraits.value is required",
            );
        }
        return { type: entry.type.trim(), value: entry.value.trim() };
    });
    const seen = new Set<string>();
    for (const trait of traits) {
        const key = JSON.stringify([trait.type, trait.value]);
        if (seen.has(key))
            throw new TraitCompetitionValidationError(
                `duplicate target trait ${trait.type}=${trait.value}`,
            );
        seen.add(key);
    }
    return normalizeTradingTraitCriteria(traits);
}

// Reuse selector validation, but reject repeated source keys instead of merging
// them: merging an AND source would silently change its applicability.
export function normalizeCompetitionPresetTarget(
    value: unknown,
): TradingTraitCompetitionSelector[] {
    if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.length > MAX_COMPETITION_PRESET_TARGET_TRAITS
    ) {
        throw new TraitCompetitionValidationError(
            "Choose one or two target traits.",
        );
    }
    const targets = normalizeExtraCompetitionTraits(value);
    if (
        targets.length !== value.length ||
        new Set(targets.map((target) => target.type)).size !== targets.length
    ) {
        throw new TraitCompetitionValidationError(
            "Choose each target trait key only once.",
        );
    }
    return targets;
}

// A preset's source fixes its applicability for every revision. Only its extras
// can change, so jobs on older versions stay eligible for future explicit updates.
export function assertCompetitionPresetSourceUnchanged(
    savedTarget: TradingTraitCompetitionSelector[],
    proposedTarget: TradingTraitCompetitionSelector[],
): void {
    const saved = normalizeCompetitionPresetTarget(savedTarget);
    const proposed = normalizeCompetitionPresetTarget(proposedTarget);
    if (
        saved.length !== proposed.length ||
        saved.some(
            (trait, index) =>
                trait.type !== proposed[index].type ||
                trait.value !== proposed[index].value,
        )
    ) {
        throw new TraitCompetitionValidationError(
            "Source target cannot change. Create a new preset.",
        );
    }
}

export function competitionPresetMatchesTarget(
    preset: Pick<TradingCompetitionPresetVersion, "targetTraits">,
    traits: TradingTraitCriterion[],
): boolean {
    const target = normalizeTradingTraitCriteria(traits);
    // Values may vary, but the complete key combination must stay the same.
    return (
        preset.targetTraits.length === target.length &&
        preset.targetTraits.every((source) =>
            target.some(
                (trait) =>
                    source.type.trim() === trait.type &&
                    (source.value === undefined ||
                        source.value.trim() === trait.value),
            ),
        )
    );
}

export function competitionTraitsLabel(
    selectors: TradingTraitCompetitionSelector[],
): string {
    return selectors
        .map(
            (trait) =>
                `${trait.type}=${
                    trait.value === undefined
                        ? "any"
                        : trait.value.toLowerCase() === "any"
                          ? JSON.stringify(trait.value)
                          : trait.value
                }`,
        )
        .join(" + ");
}

// An already selected version can stay referenced after edits or archiving.
// A new selection must use the current available definition for this target.
export function assertCompetitionPresetSelection(
    preset: {
        targetTraits: TradingTraitCompetitionSelector[];
        revision: number;
        currentRevision: number;
        archivedAt: string | null;
    } | null,
    targetTraits: TradingTraitCriterion[],
    preserveSelectedVersion: boolean,
): void {
    if (!preset || !competitionPresetMatchesTarget(preset, targetTraits)) {
        throw new TraitCompetitionValidationError(
            "Extra targets preset does not match this collection and target.",
        );
    }
    if (
        !preserveSelectedVersion &&
        (preset.archivedAt !== null ||
            preset.revision !== preset.currentRevision)
    ) {
        throw new TraitCompetitionValidationError(
            "Extra targets preset changed. Refresh and choose its current version.",
        );
    }
}
