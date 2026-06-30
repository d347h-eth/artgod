import type { TokenCard, TokenDetail } from "@artgod/shared/types";
import { TradingValidationError } from "./types.js";

const TOKEN_MARKETPLACE_BIDDING_UNAVAILABLE_MESSAGE =
    "selected token target is not available for marketplace bidding";

type TokenMarketplaceBiddingCandidate = Pick<
    TokenCard | TokenDetail,
    "tokenId" | "marketplaceBiddingSupported"
>;

// isTokenMarketplaceBiddingSupported keeps canonical-token eligibility in one trading boundary helper.
export function isTokenMarketplaceBiddingSupported(
    token: TokenMarketplaceBiddingCandidate,
): boolean {
    return token.marketplaceBiddingSupported === true;
}

// assertTokenMarketplaceBiddingSupported rejects synthetic/local-only token targets before job commands exist.
export function assertTokenMarketplaceBiddingSupported(
    token: TokenMarketplaceBiddingCandidate,
): void {
    if (isTokenMarketplaceBiddingSupported(token)) {
        return;
    }
    throw new TradingValidationError(
        `${TOKEN_MARKETPLACE_BIDDING_UNAVAILABLE_MESSAGE}: ${token.tokenId}`,
    );
}

// marketplaceBiddingSupportedTokens filters broader selections to canonical token targets only.
export function marketplaceBiddingSupportedTokens<T extends TokenMarketplaceBiddingCandidate>(
    tokens: T[],
): T[] {
    return tokens.filter(isTokenMarketplaceBiddingSupported);
}
