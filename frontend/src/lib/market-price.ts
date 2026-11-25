export type MarketPriceKind = 'ask' | 'bid';

export type MarketPriceItem = {
	kind: MarketPriceKind;
	label: string;
	href?: string | null;
	title?: string | null;
};

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const WEI_BASE = 10n ** 18n;

// Formats a wei-denominated market price with an explicit currency label.
export function formatMarketPriceLabel(params: {
	rawPrice: string | null;
	currencyAddress?: string | null;
	currencySymbol?: string | null;
}): string | null {
	const amount = formatWeiAmount(params.rawPrice);
	if (!amount) return null;
	const currency =
		params.currencySymbol ?? currencyLabelFromAddress(params.currencyAddress ?? null);
	return currency ? `${amount} ${currency}` : amount;
}

// Builds the shared token-card ask-price presentation item.
export function buildAskMarketPrice(params: {
	lastSeenMs?: number | null;
	rawPrice: string | null;
	currencyAddress: string | null;
	href?: string | null;
	title?: string | null;
}): MarketPriceItem | null {
	const label = formatMarketPriceLabel({
		rawPrice: params.rawPrice,
		currencyAddress: params.currencyAddress
	});
	if (!label) return null;
	return {
		kind: 'ask',
		label: withMarketObservation(label, params.lastSeenMs),
		href: params.href ?? null,
		title: params.title ?? 'ask'
	};
}

// Builds the shared token-card bid-price presentation item.
export function buildBidMarketPrice(params: {
	lastSeenMs?: number;
	href?: string | null;
	rawPrice: string | null;
	currencyAddress?: string | null;
	currencySymbol?: string | null;
	title?: string | null;
}): MarketPriceItem | null {
	const label = formatMarketPriceLabel({
		rawPrice: params.rawPrice,
		currencyAddress: params.currencyAddress ?? null,
		currencySymbol: params.currencySymbol ?? null
	});
	if (!label) return null;
	return {
		kind: 'bid',
		label: withMarketObservation(label, params.lastSeenMs),
		href: params.href,
		title: params.title ?? 'offer'
	};
}

export function withMarketObservation(price: string, lastSeenMs?: number | null): string {
	if (lastSeenMs == null) return price;
	return price + ' · ' + marketLastSeenLabel(lastSeenMs);
}

export function marketLastSeenLabel(lastSeenMs: number): string {
	return 'last seen ' + new Date(lastSeenMs).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function formatWeiAmount(rawPrice: string | null): string | null {
	if (!rawPrice || !/^\d+$/.test(rawPrice)) return null;
	const value = BigInt(rawPrice);
	const whole = value / WEI_BASE;
	const fraction = value % WEI_BASE;
	const fractionText = fraction.toString().padStart(18, '0').replace(/0+$/, '');
	return fractionText ? `${whole}.${fractionText}` : `${whole}`;
}

function currencyLabelFromAddress(currency: string | null): string | null {
	if (!currency) return null;
	return currency.toLowerCase() === ZERO_ADDRESS ? 'ETH' : 'WETH';
}
