import { describe, expect, it } from 'vitest';
import {
	buildLoadingBladeRail,
	pickRandomLoadingBlade,
	renderLoadingBladeBarFrame
} from './loading-blade-bar';

describe('loading-blade-bar helpers', () => {
	it('pads short blades to the fixed bar length', () => {
		expect(buildLoadingBladeRail('ABC', 10)).toEqual([
			'A',
			'B',
			'C',
			' ',
			' ',
			' ',
			' ',
			' ',
			' ',
			' '
		]);
	});

	it('renders a fixed-width frame and wraps the rail while shifting left', () => {
		const rail = buildLoadingBladeRail('ABCDE', 10);
		expect(renderLoadingBladeBarFrame({ rail, barLength: 10, offset: 0 })).toBe(
			'ABCDE     '
		);
		expect(renderLoadingBladeBarFrame({ rail, barLength: 10, offset: 1 })).toBe(
			'BCDE     A'
		);
		expect(renderLoadingBladeBarFrame({ rail, barLength: 10, offset: 9 })).toBe(
			' ABCDE    '
		);
	});

	it('uses the full blade as the wrapping rail when it exceeds the visible bar', () => {
		const rail = buildLoadingBladeRail('ABCDEFGHIJKL', 10);
		expect(renderLoadingBladeBarFrame({ rail, barLength: 10, offset: 0 })).toBe(
			'ABCDEFGHIJ'
		);
		expect(renderLoadingBladeBarFrame({ rail, barLength: 10, offset: 5 })).toBe(
			'FGHIJKLABC'
		);
	});

	it('picks a blade from the predefined list', () => {
		expect(pickRandomLoadingBlade(() => 0)).toBeDefined();
		expect(pickRandomLoadingBlade(() => 0.999999)).toBeDefined();
	});
});
