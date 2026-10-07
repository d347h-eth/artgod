import { buildRealizedPriceHistory } from '../../backend/src/domain/realized-price-history';
import {
	PRICE_HISTORY_BUCKET,
	PRICE_HISTORY_RANGE,
	PRICE_HISTORY_CURRENCY_SYMBOL,
	REALIZED_SALE_ACTION,
	type PriceHistoryBucket,
	type PriceHistoryRequest,
	type RealizedSale
} from '@artgod/shared/types/price-history';
import { BLUR_BETH_ADDRESS, FILL_PRICE_BASIS } from '@artgod/shared/market-data/fills';
import { pricedSaleFixture } from '@artgod/shared/testing/price-history';

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

type PricedFill = RealizedSale & { blockNumber: number; logIndex: number };
function fixtureHistory(fills: PricedFill[], input: PriceHistoryRequest, end: number) {
	const ordered = fills.sort(
		(a, b) =>
			a.timestamp - b.timestamp ||
			a.blockNumber - b.blockNumber ||
			a.logIndex - b.logIndex ||
			a.id.localeCompare(b.id)
	);
	return buildRealizedPriceHistory(
		ordered.map(({ blockNumber: _block, logIndex: _log, ...sale }) => sale),
		input,
		end
	);
}

export const PRICE_HISTORY_E2E = {
	path: '/e2e-harness/collection/chart',
	tokenPath: '/e2e-harness/collection/101',
	apiPattern: '**/api/*/*/price-history?*',
	canvasTextKey: '__priceChartCanvasText'
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
				...pricedSaleFixture(value.toString(), `${day}-${sale}`),
				action: sale === 1 ? REALIZED_SALE_ACTION.TakeOffer : REALIZED_SALE_ACTION.TakeAsk,
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
		action: REALIZED_SALE_ACTION.TakeOffer,
		id: 'same-time-sale',
		tokenId: '99',
		txHash: '0x' + 'ff'.repeat(32)
	});
	fills.push({
		...last,
		...CURRENCIES[0],
		action: null,
		id: 'same-time-eth-sale',
		tokenId: '98',
		txHash: '0x' + 'ee'.repeat(32)
	});
	const expanded =
		saleCount === undefined
			? fills
			: Array.from({ length: saleCount }, (_, i) => ({
					...fills[i % fills.length],
					// Stretch the dense fixture across five years, preserving exact clusters.
					timestamp:
						start +
						200 * 86400 -
						5 * 365 * 86400 +
						Math.floor((fills[i % fills.length].timestamp - start) * ((5 * 365) / 200)),
					id: 'dense-' + i,
					txHash: '0x' + i.toString(16).padStart(64, '0')
				}));
	return fixtureHistory(
		tokenId ? expanded.filter((fill) => fill.tokenId === tokenId) : expanded,
		{
			bucket,
			range:
				bucket === PRICE_HISTORY_BUCKET.Day ? PRICE_HISTORY_RANGE.All : PRICE_HISTORY_RANGE.Year,
			tokenId
		},
		start + 200 * 86400
	);
}

export function priceHistoryPrecisionFixture() {
	const history = priceHistoryFixture();
	const actions = [REALIZED_SALE_ACTION.TakeAsk, REALIZED_SALE_ACTION.TakeOffer, null];
	return fixtureHistory(
		history.sales.slice(-3).map((sale, i) => ({
			...sale,
			timestamp: history.from + i * 86400,
			...pricedSaleFixture(i === 1 ? '1234568890000000000' : '1234567890000000000', String(i)),
			action: actions[i],
			blockNumber: i,
			logIndex: i
		})),
		{ bucket: PRICE_HISTORY_BUCKET.Day, range: PRICE_HISTORY_RANGE.All },
		history.to
	);
}

export function priceHistoryOutlierFixture() {
	const history = priceHistoryFixture();
	const last = history.sales.at(-1)!;
	return fixtureHistory(
		[
			...history.sales,
			...[10n, 11n, 12n].map((price, i) => ({
				...last,
				id: 'outlier-' + i,
				timestamp: last.timestamp + 1200 * (i + 1),
				...pricedSaleFixture((price * 10n ** 18n).toString(), 'outlier-' + i),
				action: REALIZED_SALE_ACTION.TakeAsk
			}))
		].map((sale, i) => ({ ...sale, blockNumber: i, logIndex: i })),
		{ bucket: PRICE_HISTORY_BUCKET.Day, range: PRICE_HISTORY_RANGE.All },
		history.to
	);
}

export function priceHistoryZeroFixture() {
	const history = priceHistoryFixture();
	return fixtureHistory(
		history.sales.slice(-3).map((sale, i) => ({
			...sale,
			timestamp: history.from + i * 86400,
			...pricedSaleFixture((BigInt(i) * 10n ** 18n).toString(), String(i)),
			action: REALIZED_SALE_ACTION.TakeAsk,
			blockNumber: i,
			logIndex: i
		})),
		{ bucket: PRICE_HISTORY_BUCKET.Day, range: PRICE_HISTORY_RANGE.All },
		history.to
	);
}

export function priceHistoryBundleFixture() {
	const history = priceHistoryFixture();
	const last = {
		...history.sales.at(-1)!,
		...CURRENCIES[0],
		action: REALIZED_SALE_ACTION.TakeAsk
	};
	return fixtureHistory(
		[
			{
				...last,
				...pricedSaleFixture('1000000000000000000', 'single'),
				id: 'single',
				timestamp: last.timestamp - 5 * 86400,
				blockNumber: 0,
				logIndex: 0
			},
			...[
				['101', '3', '4500000000000000000'],
				['102', '1', '1500000000000000000']
			].map(([tokenId, quantity, attributedPriceWei], i) => ({
				...last,
				id: 'bundle-' + tokenId,
				tokenId,
				quantity,
				attributedPriceWei,
				executionId: 'bundle',
				executionTotalWei: '6000000000000000000',
				executionNftQuantity: '4',
				unitPrice: { numeratorWei: '6000000000000000000', denominator: '4' },
				priceBasis: FILL_PRICE_BASIS.BundleAverage,
				blockNumber: 1,
				logIndex: i
			}))
		],
		{ bucket: PRICE_HISTORY_BUCKET.Day, range: PRICE_HISTORY_RANGE.All },
		history.to
	);
}
