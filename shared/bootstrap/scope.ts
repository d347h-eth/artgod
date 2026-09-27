import { CollectionTokenScope } from "../collections/token-scope.js";
import {
    BOOTSTRAP_MANUAL_RANGE_TOTAL_SUPPLY_LIMIT,
    BOOTSTRAP_MANUAL_TOKEN_IDS_LIMIT,
} from "../config/bootstrap.js";
import { EVM_TOKEN_ID_MAX, normalizeEvmTokenId } from "../evm/token-id.js";
import { BOOTSTRAP_ENUMERATION_MODE } from "./pipeline.js";

/** Explicit user intent shared by admission, probing, the form and CLI. */
export type BootstrapScope =
    | { mode: typeof BOOTSTRAP_ENUMERATION_MODE.Enumerable }
    | {
          mode: typeof BOOTSTRAP_ENUMERATION_MODE.ManualRange;
          startTokenId: string;
          tokenCount: number;
      }
    | {
          mode: typeof BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds;
          tokenIds: string[];
      };

export const BOOTSTRAP_SCOPE_FIELD = {
    Mode: "mode",
    StartTokenId: "startTokenId",
    TokenCount: "tokenCount",
    TokenIds: "tokenIds",
} as const;

export class BootstrapScopeValidationError extends Error {
    constructor(
        readonly issues: Partial<
            Record<
                (typeof BOOTSTRAP_SCOPE_FIELD)[keyof typeof BOOTSTRAP_SCOPE_FIELD],
                string
            >
        >,
    ) {
        super(Object.values(issues).join(" "));
        this.name = "BootstrapScopeValidationError";
    }
}

/** Validate the complete declared scope; contract/sample observations do not participate. */
export function parseBootstrapScope(input: unknown): BootstrapScope {
    const value =
        input && typeof input === "object"
            ? (input as Record<string, unknown>)
            : {};
    switch (value.mode) {
        case BOOTSTRAP_ENUMERATION_MODE.Enumerable:
            return { mode: BOOTSTRAP_ENUMERATION_MODE.Enumerable };
        case BOOTSTRAP_ENUMERATION_MODE.ManualRange: {
            const startTokenId = normalizeEvmTokenId(value.startTokenId);
            const issues: BootstrapScopeValidationError["issues"] = {};
            if (startTokenId === null) {
                issues[BOOTSTRAP_SCOPE_FIELD.StartTokenId] =
                    "Enter a valid decimal first token ID.";
            }
            const count =
                typeof value.tokenCount === "number" ? value.tokenCount : NaN;
            if (
                !Number.isSafeInteger(count) ||
                count < 1 ||
                count > BOOTSTRAP_MANUAL_RANGE_TOTAL_SUPPLY_LIMIT
            ) {
                issues[BOOTSTRAP_SCOPE_FIELD.TokenCount] =
                    `Enter a token count from 1 to ${BOOTSTRAP_MANUAL_RANGE_TOTAL_SUPPLY_LIMIT.toLocaleString("en-US")}.`;
            }
            if (Object.keys(issues).length)
                throw new BootstrapScopeValidationError(issues);
            // Both fields were validated above; report all independent field errors together.
            if (BigInt(startTokenId!) + BigInt(count - 1) > EVM_TOKEN_ID_MAX) {
                throw new BootstrapScopeValidationError({
                    [BOOTSTRAP_SCOPE_FIELD.TokenCount]:
                        "The range exceeds the largest token ID. Reduce the first ID or token count.",
                });
            }
            return {
                mode: BOOTSTRAP_ENUMERATION_MODE.ManualRange,
                startTokenId: startTokenId!,
                tokenCount: count,
            };
        }
        case BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds: {
            if (!Array.isArray(value.tokenIds) || value.tokenIds.length === 0) {
                throw new BootstrapScopeValidationError({
                    [BOOTSTRAP_SCOPE_FIELD.TokenIds]:
                        "Enter decimal token IDs separated by commas or spaces.",
                });
            }
            if (value.tokenIds.length > BOOTSTRAP_MANUAL_TOKEN_IDS_LIMIT) {
                throw new BootstrapScopeValidationError({
                    [BOOTSTRAP_SCOPE_FIELD.TokenIds]: `Enter at most ${BOOTSTRAP_MANUAL_TOKEN_IDS_LIMIT.toLocaleString("en-US")} token IDs.`,
                });
            }
            const ids: string[] = [];
            for (const raw of value.tokenIds) {
                const id = normalizeEvmTokenId(raw);
                if (id === null) {
                    throw new BootstrapScopeValidationError({
                        [BOOTSTRAP_SCOPE_FIELD.TokenIds]:
                            "Enter valid decimal token IDs separated by commas or spaces.",
                    });
                }
                ids.push(id);
            }
            return {
                mode: BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds,
                tokenIds: [...new Set(ids)],
            };
        }
        default:
            throw new BootstrapScopeValidationError({
                [BOOTSTRAP_SCOPE_FIELD.Mode]: "Choose a token scope.",
            });
    }
}

export function bootstrapScopeModel(
    scope: BootstrapScope,
): CollectionTokenScope {
    switch (scope.mode) {
        case BOOTSTRAP_ENUMERATION_MODE.Enumerable:
            return CollectionTokenScope.allContractTokens();
        case BOOTSTRAP_ENUMERATION_MODE.ManualRange:
            return CollectionTokenScope.tokenRange(
                scope.startTokenId,
                scope.tokenCount,
            );
        case BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds:
            return CollectionTokenScope.explicitTokenIds();
    }
}

export function bootstrapScopeContainsToken(
    scope: BootstrapScope,
    tokenId: string,
): boolean {
    const model = bootstrapScopeModel(scope);
    return scope.mode === BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds
        ? model.containsToken(tokenId, (id) => scope.tokenIds.includes(id))
        : model.containsToken(tokenId);
}

/** A declared count is not a claim that all those token IDs currently exist. */
export function bootstrapScopeTokenCount(scope: BootstrapScope): number | null {
    switch (scope.mode) {
        case BOOTSTRAP_ENUMERATION_MODE.Enumerable:
            return null;
        case BOOTSTRAP_ENUMERATION_MODE.ManualRange:
            return scope.tokenCount;
        case BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds:
            return scope.tokenIds.length;
    }
}
