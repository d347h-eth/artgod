// OpenSea WETH offer precision: https://docs.opensea.io/changelog/api-changes.
// Offer prices use these steps; editable bid deltas use a compatible step for their range.
const WHOLE_WETH_TIER_MIN_WEI = 1_000_000_000_000_000_000n;
const TENTH_WETH_TIER_MIN_WEI = 100_000_000_000_000_000n;
const TWO_DECIMAL_STEP_WEI = 10_000_000_000_000_000n;
const THREE_DECIMAL_STEP_WEI = 1_000_000_000_000_000n;
const FOUR_DECIMAL_STEP_WEI = 100_000_000_000_000n;

// Largest valid WETH unit offer price at or below the amount; zero means no bid.
export function roundOpenSeaOfferPriceDown(amountWei: bigint): bigint {
    const stepWei = getOpenSeaOfferPriceStepWei(amountWei);
    return (amountWei / stepWei) * stepWei;
}

// Smallest valid WETH unit offer price at or above the amount; preserves zero.
export function roundOpenSeaOfferPriceUp(amountWei: bigint): bigint {
    const stepWei = getOpenSeaOfferPriceStepWei(amountWei);
    return ((amountWei + stepWei - 1n) / stepWei) * stepWei;
}

// The smallest price step for one WETH offer amount, including an empty/zero draft.
export function getOpenSeaOfferPriceStepWei(amountWei: bigint): bigint {
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

// Use the coarser endpoint step so a delta stays compatible across a mixed-tier range.
// Endpoints may be zero or temporarily reversed while the operator edits the form.
export function getOpenSeaBidDeltaStepWei(
    floorWei: bigint,
    ceilingWei: bigint,
): bigint {
    const floorStep = getOpenSeaOfferPriceStepWei(floorWei);
    const ceilingStep = getOpenSeaOfferPriceStepWei(ceilingWei);
    return floorStep > ceilingStep ? floorStep : ceilingStep;
}

// A configured UI delta must be positive and a whole number of the range's steps.
export function isValidOpenSeaBidDeltaWei(
    deltaWei: bigint,
    floorWei: bigint,
    ceilingWei: bigint,
): boolean {
    const stepWei = getOpenSeaBidDeltaStepWei(floorWei, ceilingWei);
    return deltaWei > 0n && deltaWei % stepWei === 0n;
}

// Closest positive compatible delta; halfway cases choose the larger value.
export function nearestOpenSeaBidDeltaWei(
    deltaWei: bigint,
    floorWei: bigint,
    ceilingWei: bigint,
): bigint {
    const stepWei = getOpenSeaBidDeltaStepWei(floorWei, ceilingWei);
    if (deltaWei <= stepWei) {
        return stepWei;
    }
    return ((deltaWei + stepWei / 2n) / stepWei) * stepWei;
}
