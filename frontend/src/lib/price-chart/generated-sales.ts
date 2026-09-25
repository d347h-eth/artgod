import {
	PRICE_HISTORY_BUCKET_SECONDS,
	PRICE_HISTORY_RANGE_DAYS,
	PRICE_HISTORY_LIMITS,
	PRICE_HISTORY_UNIT,
	REALIZED_SALE_ACTION,
	priceBucketStart,
	type PriceHistory,
	type PriceHistoryRequest,
	type RealizedPriceBucket,
	type RealizedSale
} from '@artgod/shared/types/price-history';

export const GENERATED_SALES_DEFAULTS = { count: 10_000, seed: 1, years: 3 } as const;
export const GENERATED_SALES_LIMITS = { seed: 0xffffffff, years: 10 } as const;
export type GeneratedSaleSettings = { count: number; seed: number; years: number };

function bounds(settings: GeneratedSaleSettings, request: PriceHistoryRequest, now: number) {
	const to = Math.floor(now / 1000) + 1;
	const days = PRICE_HISTORY_RANGE_DAYS[request.range] ?? settings.years * 365;
	const from = to - days * 86400;
	return {
		from,
		to,
		gridFrom: priceBucketStart(from, request.bucket),
		gridTo: priceBucketStart(to - 1, request.bucket) + PRICE_HISTORY_BUCKET_SECONDS[request.bucket]
	};
}

export function generatedSalesError(
	settings: GeneratedSaleSettings,
	request: PriceHistoryRequest,
	now: number
): string | null {
	if (
		!Number.isInteger(settings.count) ||
		settings.count < 1 ||
		settings.count > PRICE_HISTORY_LIMITS.fills
	)
		return `Use a whole-number dot count from 1 to ${PRICE_HISTORY_LIMITS.fills.toLocaleString('en-US')}.`;
	if (
		!Number.isInteger(settings.seed) ||
		settings.seed < 0 ||
		settings.seed > GENERATED_SALES_LIMITS.seed
	)
		return `Use a whole-number seed from 0 to ${GENERATED_SALES_LIMITS.seed}.`;
	if (
		PRICE_HISTORY_RANGE_DAYS[request.range] === null &&
		(!Number.isInteger(settings.years) ||
			settings.years < 1 ||
			settings.years > GENERATED_SALES_LIMITS.years)
	)
		return `Use a whole-number year count from 1 to ${GENERATED_SALES_LIMITS.years}.`;
	const { gridFrom, gridTo } = bounds(settings, request, now);
	if (
		(gridTo - gridFrom) / PRICE_HISTORY_BUCKET_SECONDS[request.bucket] >
		PRICE_HISTORY_LIMITS.buckets
	)
		return 'Choose a larger time bucket or a shorter range.';
	return null;
}

// Deterministic, non-cryptographic randomness makes QA runs reproducible.
function randomSequence(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let value = Math.imul(state ^ (state >>> 15), state | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

/** Browser-only QA input. It carries no real token, owner or transaction identity.
 * Produces the API shape so rendering, hit testing and indicators use their normal path. */
export function generateSaleHistory(
	settings: GeneratedSaleSettings,
	request: PriceHistoryRequest,
	now: number
): PriceHistory {
	const error = generatedSalesError(settings, request, now);
	if (error) throw new Error(error);
	const { from, to, gridFrom, gridTo } = bounds(settings, request, now);
	const random = randomSequence(settings.seed);
	const sales: RealizedSale[] = [];
	const buckets: RealizedPriceBucket[] = [];
	for (let i = 0; i < settings.count; i++) {
		// Stratified jitter preserves chronological order and spreads dots across the range.
		const position = (i + random()) / settings.count;
		const timestamp = Math.min(to - 1, from + Math.floor(position * (to - from)));
		const eth = 1.5 + 0.4 * Math.sin(position * Math.PI * 8) + (random() - 0.5) * 0.3;
		const price = BigInt(Math.round(eth * 1_000_000)) * 10n ** 12n;
		const priceWei = price.toString();
		sales.push({
			id: `generated-${settings.seed}-${i}`,
			timestamp,
			tokenId: '',
			priceWei,
			currencyAddress: '',
			currencySymbol: PRICE_HISTORY_UNIT,
			action: random() < 0.5 ? REALIZED_SALE_ACTION.TakeAsk : REALIZED_SALE_ACTION.TakeOffer,
			seller: null,
			buyer: null,
			txHash: ''
		});
		// These fixture buckets describe the generated dots only, never stored fill eligibility.
		const bucketTime = priceBucketStart(timestamp, request.bucket);
		const previous = buckets.at(-1);
		if (!previous || previous.timestamp !== bucketTime) {
			buckets.push({
				timestamp: bucketTime,
				openWei: priceWei,
				highWei: priceWei,
				lowWei: priceWei,
				closeWei: priceWei,
				volume: 1,
				turnoverWei: priceWei
			});
		} else {
			if (price > BigInt(previous.highWei)) previous.highWei = priceWei;
			if (price < BigInt(previous.lowWei)) previous.lowWei = priceWei;
			previous.closeWei = priceWei;
			previous.volume++;
			previous.turnoverWei = (BigInt(previous.turnoverWei) + price).toString();
		}
	}
	return {
		unit: PRICE_HISTORY_UNIT,
		bucket: request.bucket,
		bucketSeconds: PRICE_HISTORY_BUCKET_SECONDS[request.bucket],
		range: request.range,
		from: gridFrom,
		to: gridTo,
		sales,
		buckets
	};
}
