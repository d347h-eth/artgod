import { describe, expect, it } from 'vitest';
import {
	applyQueryControlPreferenceToQuery,
	readQueryControlPreference,
	type QueryControlPreferenceDefinitions,
	writeQueryControlPreference
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

function createMemoryStorage(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
		values
	};
}

describe('global query-control preference storage', () => {
	it('normalizes global preference reads and writes through one storage helper', () => {
		const storage = createMemoryStorage({
			'example.preference': JSON.stringify({
				view: 'jobs',
				scope: 'unknown'
			})
		});

		expect(
			readQueryControlPreference({
				storageKey: 'example.preference',
				definitions: DEFINITIONS,
				storage
			})
		).toEqual({ view: 'jobs' });

		expect(
			writeQueryControlPreference({
				storageKey: 'example.preference',
				definitions: DEFINITIONS,
				preference: {
					view: 'book',
					scope: 'traits'
				},
				storage
			})
		).toBe(true);

		expect(JSON.parse(storage.values.get('example.preference') ?? '{}')).toEqual({
			view: 'book',
			scope: 'traits'
		});
	});

	it('reports failed persistence without throwing away the current navigation', () => {
		expect(
			writeQueryControlPreference({
				storageKey: 'example.preference',
				definitions: DEFINITIONS,
				preference: { view: 'jobs', scope: 'traits' },
				storage: {
					getItem: () => null,
					setItem: () => {
						throw new Error('Storage unavailable');
					}
				}
			})
		).toBe(false);
	});

	it('round-trips an intentional reset while keeping a missing preference absent', () => {
		const definitions = {
			filter: { param: 'filter', values: [null, 'active'] }
		} as const satisfies QueryControlPreferenceDefinitions<{ filter: 'active' | null }>;
		const storage = createMemoryStorage();
		const read = () =>
			readQueryControlPreference({ storageKey: 'example.preference', definitions, storage });
		expect(read()).toBeNull();
		writeQueryControlPreference<{ filter: 'active' | null }>({
			storageKey: 'example.preference',
			definitions,
			preference: { filter: null },
			storage
		});
		expect(read()).toEqual({ filter: null });
		writeQueryControlPreference<{ filter: 'active' | null }>({
			storageKey: 'example.preference',
			definitions,
			preference: { filter: 'active' },
			storage
		});
		expect(read()).toEqual({ filter: 'active' });
	});

	it('rejects null for a preference that does not declare a cleared selection', () => {
		expect(
			readQueryControlPreference({
				storageKey: 'example.preference',
				definitions: DEFINITIONS,
				storage: createMemoryStorage({
					'example.preference': JSON.stringify({ view: null, scope: 'traits' })
				})
			})
		).toEqual({ scope: 'traits' });
	});
});

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

	it('omits a declared reset and preserves explicit URL values for nullable filters', () => {
		const definitions = {
			filter: { param: 'filter', values: ['active', null], defaultValue: null }
		} as const satisfies QueryControlPreferenceDefinitions<{ filter: 'active' | null }>;
		expect(
			applyQueryControlPreferenceToQuery({
				query: new URLSearchParams(),
				definitions,
				preference: { filter: 'active' }
			}).toString()
		).toBe('filter=active');
		expect(
			applyQueryControlPreferenceToQuery({
				query: new URLSearchParams(),
				definitions,
				preference: { filter: null }
			}).toString()
		).toBe('');
		expect(
			applyQueryControlPreferenceToQuery({
				query: new URLSearchParams('filter=active'),
				definitions,
				preference: { filter: null }
			}).toString()
		).toBe('filter=active');
	});
});
