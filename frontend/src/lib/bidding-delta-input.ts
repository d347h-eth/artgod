import { formatEther, parseEther } from 'viem';
import {
	getOpenSeaBidDeltaStepWei,
	isValidOpenSeaBidDeltaWei,
	nearestOpenSeaBidDeltaWei
} from '@artgod/shared/trading/open-sea-offer-price';
import {
	resolveBiddingPriceTierCeilingWei,
	resolveBiddingPriceTierFloorWei
} from '@artgod/shared/trading/bidding-price-tier-pricing';
import { TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND } from '@artgod/shared/types';
import type {
	ApiBiddingPriceTier,
	ApiBiddingPriceTierCeilingConfig,
	ApiBiddingPriceTierFloorConfig
} from '$lib/api-types';

type BiddingDeltaRange = { floorEth: string; ceilingEth: string };

// Incomplete prices still constrain the delta using whichever endpoint is available.
export function validateBiddingDeltaInput(params: BiddingDeltaRange & { deltaEth: string }) {
	const floorWei = nonNegativePriceWei(params.floorEth);
	const ceilingWei = nonNegativePriceWei(params.ceilingEth);
	const stepEth = formatEther(getOpenSeaBidDeltaStepWei(floorWei, ceilingWei));
	const delta = parseEditableEth(params.deltaEth);
	const isValid =
		delta !== null && delta.exact && isValidOpenSeaBidDeltaWei(delta.wei, floorWei, ceilingWei);
	const nearestDeltaEth =
		delta === null
			? stepEth
			: formatEther(nearestOpenSeaBidDeltaWei(delta.wei, floorWei, ceilingWei));
	const warning = isValid
		? null
		: delta === null
			? `Enter a positive delta in steps of ${stepEth} ETH.`
			: `Invalid delta. Closest valid value: ${nearestDeltaEth} ETH.`;
	// Keep editable text intact, but submit canonical decimals accepted by the API.
	const normalizedDeltaEth = delta !== null && isValid ? formatEther(delta.wei) : null;
	return { isValid, stepEth, nearestDeltaEth, normalizedDeltaEth, warning };
}

// Only range changes reconcile the input; delta keystrokes keep the operator's text.
export function reconcileBiddingDeltaEth(params: BiddingDeltaRange & { deltaEth: string }): string {
	const validation = validateBiddingDeltaInput(params);
	return validation.isValid ? params.deltaEth : validation.nearestDeltaEth;
}

// An incompatible collection default is ignored in favor of the target's minimum step.
export function resolveDefaultBiddingDeltaEth(
	params: BiddingDeltaRange & { defaultDeltaEth: string }
): string {
	const validation = validateBiddingDeltaInput({ ...params, deltaEth: params.defaultDeltaEth });
	return validation.isValid ? params.defaultDeltaEth : validation.stepEth;
}

// Resolve only complete endpoints using the same offsets/percent math as persistence.
export function resolveBiddingPriceTierDraftRange(params: {
	floorConfig: ApiBiddingPriceTierFloorConfig;
	ceilingConfig: ApiBiddingPriceTierCeilingConfig;
	parentTier: Pick<ApiBiddingPriceTier, 'resolvedFloorEth' | 'resolvedCeilingEth'> | null;
}): BiddingDeltaRange {
	let floorWei: bigint | undefined;
	let ceilingWei: bigint | undefined;
	try {
		floorWei = resolveBiddingPriceTierFloorWei(
			params.floorConfig,
			parseExactEth(params.parentTier?.resolvedFloorEth ?? '') ?? undefined
		);
	} catch {
		// An unfinished floor must not hide a complete fixed ceiling's precision.
	}
	if (
		floorWei !== undefined ||
		params.ceilingConfig.kind !== TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.FloorDelta
	) {
		try {
			ceilingWei = resolveBiddingPriceTierCeilingWei(
				params.ceilingConfig,
				floorWei ?? 0n,
				parseExactEth(params.parentTier?.resolvedCeilingEth ?? '') ?? undefined
			);
		} catch {
			// Relative/percent drafts can be temporarily incomplete while typing.
		}
	}
	return {
		floorEth: floorWei === undefined ? '' : formatEther(floorWei),
		ceilingEth: ceilingWei === undefined ? '' : formatEther(ceilingWei)
	};
}

function nonNegativePriceWei(value: string): bigint {
	try {
		// Match the backend's price rounding to wei; delta text still requires exact precision.
		const amount = parseEther(value.trim());
		return amount > 0n ? amount : 0n;
	} catch {
		// Prices can be temporarily incomplete while editing.
		return 0n;
	}
}

function parseExactEth(value: string): bigint | null {
	const amount = parseEditableEth(value);
	return amount?.exact ? amount.wei : null;
}

function parseEditableEth(value: string): { wei: bigint; exact: boolean } | null {
	const normalized = value.trim();
	if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) {
		return null;
	}
	const sign = normalized.startsWith('-') ? -1n : 1n;
	const unsigned = normalized.replace(/^[+-]/, '');
	const [whole, fraction = ''] = unsigned.split('.');
	const significantFraction = fraction.replace(/0+$/, '');
	// Sub-wei digits remain invalid. Truncating them preserves the nearest price step,
	// whose half-step boundaries are whole wei, without parseEther rounding the text.
	const wei = sign * parseEther(`${whole || '0'}.${significantFraction.slice(0, 18)}`);
	return { wei, exact: significantFraction.length <= 18 };
}
