import { formatMarketPriceLabel } from '$lib/market-price';

export function formatListingPrice(rawPrice: string | null, currency: string | null): string | null {
	return formatMarketPriceLabel({ rawPrice, currencyAddress: currency });
}
