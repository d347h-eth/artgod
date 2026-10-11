import { describe, expect, it } from 'vitest';
import { bidBookCriteriaToBrowseFilters } from './bidding-bid-book-display';

describe('bid book criteria navigation', () => {
	it('preserves exact values and both numeric bounds in the browse filter', () => {
		expect(
			bidBookCriteriaToBrowseFilters([
				{ type: 'Mode', value: 'Terrain' },
				{ type: 'Level', min: 1, max: 2 }
			])
		).toEqual({
			traits: [{ key: 'Mode', value: 'Terrain' }],
			traitRanges: [{ key: 'Level', fromValue: '1', toValue: '2' }]
		});
	});
	it('omits navigation when existing browse ranges cannot represent the whole scope', () => {
		for (const min of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
			expect(
				bidBookCriteriaToBrowseFilters([
					{ type: 'Mode', value: 'Terrain' },
					{ type: 'Level', min, max: min + 2 }
				])
			).toBeNull();
		}
	});
});
