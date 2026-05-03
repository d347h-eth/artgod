import { describe, expect, it } from 'vitest';
import {
	applyQueryControlPreferenceToQuery,
	type QueryControlPreferenceDefinitions
} from '$lib/query-control-preferences';

type ExamplePreference = {
	view: 'book' | 'jobs';
	scope: 'collection' | 'traits';
};

const DEFINITIONS = {
	view: {
		param: 'view',
		values: ['book', 'jobs']
	},
	scope: {
		param: 'scope',
		values: ['collection', 'traits']
	}
} as const satisfies QueryControlPreferenceDefinitions<ExamplePreference>;

describe('applyQueryControlPreferenceToQuery', () => {
	it('adds stored query-control values when URL omits them', () => {
		const query = applyQueryControlPreferenceToQuery({
			query: new URLSearchParams('traits=Mode%3ATerrain'),
			definitions: DEFINITIONS,
			preference: {
				view: 'book',
				scope: 'traits'
			}
		});

		expect(query.toString()).toBe('traits=Mode%3ATerrain&scope=traits');
	});

	it('keeps explicit URL values ahead of stored values', () => {
		const query = applyQueryControlPreferenceToQuery({
			query: new URLSearchParams('view=book&scope=collection'),
			definitions: DEFINITIONS,
			preference: {
				view: 'jobs',
				scope: 'traits'
			}
		});

		expect(query.toString()).toBe('view=book&scope=collection');
	});

	it('omits stored default values from the generated URL', () => {
		const query = applyQueryControlPreferenceToQuery({
			query: new URLSearchParams(),
			definitions: DEFINITIONS,
			preference: {
				view: 'book',
				scope: 'collection'
			}
		});

		expect(query.toString()).toBe('');
	});
});
