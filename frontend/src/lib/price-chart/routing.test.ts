import { expect, it } from 'vitest';
import { buildCollectionChartFiltersHref } from './routing';

it('replaces trait aliases while preserving the chart scope and preferences', () => {
	const url = new URL(
		'http://localhost/ethereum/collection/chart?range=1y&bucket=4h&token_id=7&media_preference=disabled&trait=Old:a&traits=Old:b&trait_range=Level:1..2&trait_ranges=Other:3..4'
	);
	const href = buildCollectionChartFiltersHref(
		url,
		[
			{ key: 'Zone', value: 'A' },
			{ key: 'Zone', value: 'B' }
		],
		[{ key: 'Level', fromValue: '7', toValue: null }]
	);
	const selected = new URL(href, url);
	expect(selected.pathname).toBe(url.pathname);
	expect([...selected.searchParams]).toEqual([
		['range', '1y'],
		['bucket', '4h'],
		['token_id', '7'],
		['media_preference', 'disabled'],
		['traits', 'Zone:A'],
		['traits', 'Zone:B'],
		['trait_ranges', 'Level:7..']
	]);
	expect(buildCollectionChartFiltersHref(selected, [], [])).toBe(
		'/ethereum/collection/chart?range=1y&bucket=4h&token_id=7&media_preference=disabled'
	);
});
