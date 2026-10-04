import { describe, expect, it } from 'vitest';
import {
	TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND as Ceiling,
	TRADING_BIDDING_PRICE_TIER_DELTA_KIND as Delta,
	TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND as Floor
} from '@artgod/shared/types';
import {
	reconcileBiddingDeltaEth,
	resolveBiddingPriceTierDraftRange,
	resolveDefaultBiddingDeltaEth,
	validateBiddingDeltaInput
} from '$lib/bidding-delta-input';

describe('bidding delta input', () => {
	it.each([
		['1.3000000000000000001', '1.4000000000000000001', '1.3', '1.4', '0.01', '0.001'],
		['0.3', '1.4000000000000000001', '0.3', '1.4', '0.01', '0.001'],
		['1.4000000000000000001', '0.3', '1.4', '0.3', '0.01', '0.001'],
		['0.3', '0.99999999999999999996', '0.3', '1', '0.01', '0.001'],
		['0.3', '0.9999999999999999994', '0.3', '0.999999999999999999', '0.001', '0.0001'],
		['0.03', '0.09999999999999999996', '0.03', '0.1', '0.001', '0.0001'],
		['0.03', '0.0999999999999999994', '0.03', '0.099999999999999999', '0.0001', '0.00001'],
		['1.3000000000000000000', '1.4000000000000000000', '1.3', '1.4', '0.01', '0.001']
	])(
		'keeps validation consistent with the persisted range for %s–%s',
		(floorEth, ceilingEth, persistedFloorEth, persistedCeilingEth, stepEth, deltaEth) => {
			const input = { floorEth, ceilingEth, deltaEth };
			const persistedRange = { floorEth: persistedFloorEth, ceilingEth: persistedCeilingEth };
			const validation = validateBiddingDeltaInput(input);
			expect(validation).toMatchObject({
				isValid: false,
				stepEth,
				nearestDeltaEth: stepEth,
				normalizedDeltaEth: null,
				warning: `Invalid delta. Closest valid value: ${stepEth} ETH.`
			});
			expect(validation).toEqual(validateBiddingDeltaInput({ ...persistedRange, deltaEth }));
			expect(reconcileBiddingDeltaEth(input)).toBe(stepEth);
			expect(resolveDefaultBiddingDeltaEth({ ...input, defaultDeltaEth: deltaEth })).toBe(stepEth);

			const corrected = validateBiddingDeltaInput({ ...input, deltaEth: stepEth });
			expect(corrected).toMatchObject({ isValid: true, warning: null });
			expect(corrected).toEqual(
				validateBiddingDeltaInput({ ...persistedRange, deltaEth: stepEth })
			);
		}
	);

	it.each(['', '.', 'invalid', '-1'])(
		'uses a complete ceiling while the floor is temporarily %s',
		(floorEth) => {
			expect(
				validateBiddingDeltaInput({ floorEth, ceilingEth: '1.4', deltaEth: '0.001' })
			).toMatchObject({ isValid: false, stepEth: '0.01', nearestDeltaEth: '0.01' });
		}
	);

	it.each([
		['1.3', '1.4', '0.001', '0.01'],
		['1.3', '1.4', '0.014999999999999999', '0.01'],
		['1.3', '1.4', '0.015', '0.02'],
		['1.3', '1.4', '0.0149999999999999999', '0.01'],
		['1.3', '1.4', '0.0150000000000000001', '0.02'],
		['1.3', '1.4', '0.0100000000000000001', '0.01'],
		['0.1', '0.9', '0.0045', '0.005'],
		['0.01', '0.09', '0.00015', '0.0002'],
		['0.0999', '0.1', '0.0001', '0.001'],
		['0.999', '1', '0.001', '0.01'],
		['', '1.4', '0', '0.01'],
		['1.4', '', '-0.001', '0.01']
	])(
		'shows the exact nearest value for %s–%s with delta %s',
		(floorEth, ceilingEth, deltaEth, nearest) => {
			const result = validateBiddingDeltaInput({ floorEth, ceilingEth, deltaEth });
			expect(result.isValid).toBe(false);
			expect(result.nearestDeltaEth).toBe(nearest);
			expect(result.warning).toBe(`Invalid delta. Closest valid value: ${nearest} ETH.`);
		}
	);

	it.each(['', '.', '+', '1e-2', 'garbage'])(
		'rejects incomplete or unrepresentable input: %s',
		(deltaEth) => {
			expect(
				validateBiddingDeltaInput({ floorEth: '1.3', ceilingEth: '1.4', deltaEth })
			).toMatchObject({
				isValid: false,
				warning: 'Enter a positive delta in steps of 0.01 ETH.'
			});
		}
	);

	it('accepts equivalent decimals without rewriting the typed text', () => {
		for (const deltaEth of ['0.0200', '.02', '+0.02', ' 0.02 ', '1.', '0.020000000000000000000']) {
			const params = { floorEth: '1.3', ceilingEth: '1.4', deltaEth };
			expect(validateBiddingDeltaInput(params)).toMatchObject({ isValid: true, warning: null });
			expect(validateBiddingDeltaInput(params).normalizedDeltaEth).toBe(
				deltaEth === '1.' ? '1' : '0.02'
			);
			expect(reconcileBiddingDeltaEth(params)).toBe(deltaEth);
		}
	});

	it('reconciles only incompatible values when the range changes', () => {
		expect(
			reconcileBiddingDeltaEth({ floorEth: '1.3', ceilingEth: '1.4', deltaEth: '0.001' })
		).toBe('0.01');
		expect(
			reconcileBiddingDeltaEth({ floorEth: '0.1', ceilingEth: '0.9', deltaEth: '0.0200' })
		).toBe('0.0200');
	});

	it('does not expose an invalid delta for submission', () => {
		expect(
			validateBiddingDeltaInput({ floorEth: '1.3', ceilingEth: '1.4', deltaEth: '0.015' })
				.normalizedDeltaEth
		).toBeNull();
	});

	it('applies a default only when compatible with the target', () => {
		expect(
			resolveDefaultBiddingDeltaEth({
				floorEth: '0.1',
				ceilingEth: '0.9',
				defaultDeltaEth: '0.007'
			})
		).toBe('0.007');
		expect(
			resolveDefaultBiddingDeltaEth({
				floorEth: '1.3',
				ceilingEth: '1.4',
				defaultDeltaEth: '0.007'
			})
		).toBe('0.01');
		expect(
			resolveDefaultBiddingDeltaEth({
				floorEth: '0.01',
				ceilingEth: '0.09',
				defaultDeltaEth: '0.00015'
			})
		).toBe('0.0001');
		expect(
			resolveDefaultBiddingDeltaEth({ floorEth: '', ceilingEth: '', defaultDeltaEth: 'invalid' })
		).toBe('0.0001');
	});
});

describe('price tier draft range', () => {
	it('uses parent percent and floor offsets before validating a delta', () => {
		const range = resolveBiddingPriceTierDraftRange({
			floorConfig: { kind: Floor.ParentDelta, deltaKind: Delta.Percent, percent: '25' },
			ceilingConfig: { kind: Ceiling.FloorDelta, deltaKind: Delta.Absolute, deltaEth: '0.1' },
			parentTier: { resolvedFloorEth: '0.8', resolvedCeilingEth: '0.9' }
		});
		expect(range).toEqual({ floorEth: '1', ceilingEth: '1.1' });
		expect(validateBiddingDeltaInput({ ...range, deltaEth: '0.001' }).stepEth).toBe('0.01');
	});

	it('uses a complete fixed ceiling while the floor is incomplete', () => {
		expect(
			resolveBiddingPriceTierDraftRange({
				floorConfig: { kind: Floor.Fixed, valueEth: '' },
				ceilingConfig: { kind: Ceiling.Fixed, valueEth: '1.4' },
				parentTier: null
			})
		).toEqual({ floorEth: '', ceilingEth: '1.4' });
	});

	it('does not invent relative prices from incomplete inputs', () => {
		expect(
			resolveBiddingPriceTierDraftRange({
				floorConfig: { kind: Floor.ParentDelta, deltaKind: Delta.Absolute, deltaEth: '' },
				ceilingConfig: { kind: Ceiling.FloorDelta, deltaKind: Delta.Absolute, deltaEth: '1' },
				parentTier: null
			})
		).toEqual({ floorEth: '', ceilingEth: '' });
	});

	it('uses the parent ceiling independently from an incomplete floor', () => {
		expect(
			resolveBiddingPriceTierDraftRange({
				floorConfig: { kind: Floor.Fixed, valueEth: '' },
				ceilingConfig: { kind: Ceiling.ParentDelta, deltaKind: Delta.Percent, percent: '20' },
				parentTier: { resolvedFloorEth: '0.8', resolvedCeilingEth: '0.9' }
			})
		).toEqual({ floorEth: '', ceilingEth: '1.08' });
	});
});
