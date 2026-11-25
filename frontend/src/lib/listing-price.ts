import { formatMarketPriceLabel, withMarketObservation } from '$lib/market-price';

export function formatListingPrice(
	rawPrice: string | null,
	currency: string | null,
	lastSeenMs?: number | null
): string | null {
	const price = formatMarketPriceLabel({ rawPrice, currencyAddress: currency });
	return price ? withMarketObservation(price, lastSeenMs) : null;
}
