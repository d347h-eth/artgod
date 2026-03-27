const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const WEI_BASE = 10n ** 18n;

export function formatListingPrice(rawPrice: string | null, currency: string | null): string | null {
	if (!rawPrice || !currency || !/^\d+$/.test(rawPrice)) return null;
	const value = BigInt(rawPrice);
	const whole = value / WEI_BASE;
	const fraction = value % WEI_BASE;
	const fractionText = fraction.toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '');
	const amount = fractionText ? `${whole}.${fractionText}` : `${whole}`;
	return `${amount} ${listingCurrencyLabel(currency)}`;
}

function listingCurrencyLabel(currency: string): string {
	return currency.toLowerCase() === ZERO_ADDRESS ? 'ETH' : 'WETH';
}
