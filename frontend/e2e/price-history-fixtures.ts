import {
	buildRealizedPriceHistory,
	type PricedFill
} from '../../backend/src/domain/realized-price-history';
import {
	PRICE_HISTORY_BUCKET,
	PRICE_HISTORY_RANGE,
	PRICE_HISTORY_CURRENCY_SYMBOL,
	type PriceHistoryBucket
} from '@artgod/shared/types/price-history';
import { BLUR_BETH_ADDRESS } from '@artgod/shared/market-data/fills';

const CURRENCIES = [
	{
		currencyAddress: '0x0000000000000000000000000000000000000000',
		currencySymbol: PRICE_HISTORY_CURRENCY_SYMBOL.Eth
	},
	{
		currencyAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
		currencySymbol: PRICE_HISTORY_CURRENCY_SYMBOL.Weth
	},
	{
		currencyAddress: BLUR_BETH_ADDRESS,
		currencySymbol: PRICE_HISTORY_CURRENCY_SYMBOL.Beth
	}
];

export const PRICE_HISTORY_E2E = {
	path: '/e2e-harness/collection/chart',
	tokenPath: '/e2e-harness/collection/101',
	apiPattern: '**/api/*/*/price-history?*'
} as const;
export function priceHistoryFixture(
	bucket = PRICE_HISTORY_BUCKET.Day as PriceHistoryBucket,
	tokenId?: string,
	saleCount?: number
) {
	const start = Date.UTC(2025, 9, 1) / 1000;
	const fills: PricedFill[] = [];
	for (let day = 0; day < 200; day++) {
		if (day >= 140 && day < 150) continue; // Visible blank time in all modes.
		for (let sale = 0; sale < 3; sale++) {
			const value =
				BigInt(1000 + Math.round(Math.sin(day / 9) * 220) + day * 2 + sale * 40) * 10n ** 15n +
				(day === 199 && sale === 0 ? 560000000000000n : 0n);
			fills.push({
				id: `${day}-${sale}`,
				timestamp: start + day * 86400 + (sale === 1 ? 18000 : 30000),
				tokenId: String(sale + 101),
				priceWei: value.toString(),
				seller: '0x' + '29'.repeat(20),
				buyer: '0x' + 'ab'.repeat(20),
				...CURRENCIES[sale],
				blockNumber: day * 3 + sale,
				logIndex: sale,
				txHash: '0x' + (day * 3 + sale).toString(16).padStart(64, '0')
			});
		}
	}
	// Distinct fills at the exact same coordinate must all retain their currency.
	const last = fills.at(-1)!;
	fills.push({
		...last,
		...CURRENCIES[1],
		id: 'same-time-sale',
		tokenId: '99',
		txHash: '0x' + 'ff'.repeat(32)
	});
	fills.push({
		...last,
		...CURRENCIES[0],
		id: 'same-time-eth-sale',
		tokenId: '98',
		txHash: '0x' + 'ee'.repeat(32)
	});
	const expanded =
		saleCount === undefined
			? fills
			: Array.from({ length: saleCount }, (_, i) => ({
					...fills[i % fills.length],
					id: 'dense-' + i,
					txHash: '0x' + i.toString(16).padStart(64, '0')
				}));
	return buildRealizedPriceHistory(
		tokenId ? expanded.filter((fill) => fill.tokenId === tokenId) : expanded,
		{ bucket, range: PRICE_HISTORY_RANGE.All, tokenId },
		start + 200 * 86400
	);
}
