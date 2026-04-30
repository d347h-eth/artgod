import { parseOpenSeaBiddingOffer } from "@artgod/shared/trading/open-sea-bidding-offers";
import { logger } from "@artgod/shared/utils";
import { TRADING_BIDDING_BID_SCOPE_KIND } from "@artgod/shared/types";
import type { TradingTraitCriterion } from "@artgod/shared/types";
import type {
    OrderLocalTokenSetStatus,
    OrderSourceScopeKind,
} from "../../domain/orders.js";
import {
    ORDER_LOCAL_TOKEN_SET_STATUS,
    ORDER_SOURCE_SCOPE_KIND,
} from "../../domain/orders.js";
import type { TokenSetSchema } from "../../domain/token-sets.js";
import { normalizeUniqueAttributeList } from "../../domain/attributes.js";
import { assertAddress, normalizeCriteriaRoot } from "./normalizer-utils.js";
import {
    buildAttributeSchema,
    buildCollectionSchema,
} from "../token-sets/utils.js";

export type OpenSeaBiddingOrderTerms = {
    orderId: string;
    maker: string;
    contract: string;
    tokenId: string | null;
    sourceScopeKind: OrderSourceScopeKind;
    sourceSchema: TokenSetSchema | null;
    sourceCriteriaRoot: string | null;
    sourceEncodedTokenIds: string | null;
    localTokenSetStatus: OrderLocalTokenSetStatus;
    quantity: string;
    price: string;
    currency: string;
    validFrom: number | null;
    validUntil: number | null;
};

// Maps the bidder-owned OpenSea offer parser into the indexer's persisted order contract.
export function parseRequiredOpenSeaBiddingOrderTerms(
    rawOffer: unknown,
    params: {
        context: Record<string, unknown>;
    },
): OpenSeaBiddingOrderTerms {
    try {
        return parseRequiredOpenSeaBiddingOrderTermsInner(rawOffer, params);
    } catch (error) {
        if (error instanceof LoggedOpenSeaBiddingParseError) {
            throw error;
        }

        logger.error("OpenSea buy offer shared parser failed", {
            component: "OpenSeaBiddingOrderTerms",
            action: "parseRequiredOpenSeaBiddingOrderTerms",
            reason: "exception",
            error: String(error),
            ...params.context,
        });
        throw error;
    }
}

function parseRequiredOpenSeaBiddingOrderTermsInner(
    rawOffer: unknown,
    params: {
        context: Record<string, unknown>;
    },
): OpenSeaBiddingOrderTerms {
    const parsed = parseOpenSeaBiddingOffer(rawOffer);
    if (!parsed) {
        throwLoggedParseError("shared parser returned null", params.context);
    }

    const collectionAddress = parsed.collectionAddress
        ? assertAddress(parsed.collectionAddress, "collectionAddress")
        : null;
    if (!collectionAddress) {
        throwLoggedParseError("missing collection address", params.context);
    }

    const currency = parsed.currencyAddress
        ? assertAddress(parsed.currencyAddress, "currencyAddress")
        : null;
    if (!currency) {
        throwLoggedParseError("missing currency address", params.context);
    }

    const scope = mapBidScopeToOrderScope(collectionAddress, parsed.bidScope);
    if (!scope) {
        throwLoggedParseError("unable to map parsed bid scope", {
            ...params.context,
            parsedScopeKind: parsed.bidScope.kind,
            parsedScopeLabel: parsed.bidScope.label,
        });
    }

    return {
        orderId: parsed.id.toLowerCase(),
        maker: parsed.maker,
        contract: collectionAddress,
        tokenId: scope.tokenId,
        sourceScopeKind: scope.sourceScopeKind,
        sourceSchema: scope.sourceSchema,
        sourceCriteriaRoot: normalizeCriteriaRoot(
            parsed.criteriaRoot,
            "criteriaRoot",
        ),
        sourceEncodedTokenIds: scope.sourceEncodedTokenIds,
        localTokenSetStatus: scope.localTokenSetStatus,
        quantity: parsed.quantity.toString(),
        price: parsed.price.toString(),
        currency,
        validFrom: parsed.validFrom ?? null,
        validUntil: parsed.expirationTime ?? null,
    };
}

function mapBidScopeToOrderScope(
    collectionAddress: string,
    scope: {
        kind: string;
        tokenId: string | null;
        traits: TradingTraitCriterion[];
        encodedTokenIds: string | null;
    },
): {
    tokenId: string | null;
    sourceScopeKind: OrderSourceScopeKind;
    sourceSchema: TokenSetSchema | null;
    sourceEncodedTokenIds: string | null;
    localTokenSetStatus: OrderLocalTokenSetStatus;
} | null {
    if (scope.kind === TRADING_BIDDING_BID_SCOPE_KIND.Token) {
        if (!scope.tokenId) {
            return null;
        }
        return {
            tokenId: scope.tokenId,
            sourceScopeKind: ORDER_SOURCE_SCOPE_KIND.Token,
            sourceSchema: null,
            sourceEncodedTokenIds: null,
            localTokenSetStatus: ORDER_LOCAL_TOKEN_SET_STATUS.None,
        };
    }

    if (scope.kind === TRADING_BIDDING_BID_SCOPE_KIND.Trait) {
        const attributes = normalizeUniqueAttributeList(
            scope.traits.map((trait) => ({
                key: trait.type,
                value: trait.value,
            })),
        );
        if (attributes.length === 0) {
            return null;
        }
        return {
            tokenId: null,
            sourceScopeKind: ORDER_SOURCE_SCOPE_KIND.Attribute,
            sourceSchema: buildAttributeSchema(collectionAddress, attributes),
            sourceEncodedTokenIds: scope.encodedTokenIds ?? null,
            localTokenSetStatus: ORDER_LOCAL_TOKEN_SET_STATUS.Unresolved,
        };
    }

    if (scope.kind === TRADING_BIDDING_BID_SCOPE_KIND.Collection) {
        return {
            tokenId: null,
            sourceScopeKind: ORDER_SOURCE_SCOPE_KIND.Collection,
            sourceSchema: buildCollectionSchema(collectionAddress),
            sourceEncodedTokenIds: scope.encodedTokenIds ?? null,
            localTokenSetStatus: ORDER_LOCAL_TOKEN_SET_STATUS.Unresolved,
        };
    }

    if (scope.kind === TRADING_BIDDING_BID_SCOPE_KIND.TokenSet) {
        return {
            tokenId: null,
            sourceScopeKind: ORDER_SOURCE_SCOPE_KIND.TokenSet,
            sourceSchema: null,
            sourceEncodedTokenIds: scope.encodedTokenIds ?? null,
            localTokenSetStatus: ORDER_LOCAL_TOKEN_SET_STATUS.Unresolved,
        };
    }

    return null;
}

function throwLoggedParseError(
    reason: string,
    context: Record<string, unknown>,
): never {
    logger.error("OpenSea buy offer shared parser failed", {
        component: "OpenSeaBiddingOrderTerms",
        action: "parseRequiredOpenSeaBiddingOrderTerms",
        reason,
        ...context,
    });
    throw new LoggedOpenSeaBiddingParseError(reason);
}

class LoggedOpenSeaBiddingParseError extends Error {
    constructor(reason: string) {
        super(`OpenSea buy offer shared parser failed: ${reason}`);
    }
}
