// OpenSea WETH offer precision: https://docs.opensea.io/changelog/api-changes.
// These are price steps, independent of the operator's configured bid delta.
const WHOLE_WETH_TIER_MIN_WEI = 1_000_000_000_000_000_000n;
const TENTH_WETH_TIER_MIN_WEI = 100_000_000_000_000_000n;
const TWO_DECIMAL_STEP_WEI = 10_000_000_000_000_000n;
const THREE_DECIMAL_STEP_WEI = 1_000_000_000_000_000n;
const FOUR_DECIMAL_STEP_WEI = 100_000_000_000_000n;

// Largest valid WETH unit offer price at or below the amount; zero means no bid.
export function roundOpenSeaOfferPriceDown(amountWei: bigint): bigint {
    const stepWei = getOfferPriceStepWei(amountWei);
    return (amountWei / stepWei) * stepWei;
}

// Smallest valid WETH unit offer price at or above the amount; preserves zero.
export function roundOpenSeaOfferPriceUp(amountWei: bigint): bigint {
    const stepWei = getOfferPriceStepWei(amountWei);
    return ((amountWei + stepWei - 1n) / stepWei) * stepWei;
}

function getOfferPriceStepWei(amountWei: bigint): bigint {
    if (amountWei < 0n) {
        throw new RangeError("Offer price must be non-negative");
    }
    if (amountWei >= WHOLE_WETH_TIER_MIN_WEI) {
        return TWO_DECIMAL_STEP_WEI;
    }
    if (amountWei >= TENTH_WETH_TIER_MIN_WEI) {
        return THREE_DECIMAL_STEP_WEI;
    }
    return FOUR_DECIMAL_STEP_WEI;
}
