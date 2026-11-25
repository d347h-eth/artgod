import { expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import { TRAIT_CATALOG_QUERY } from '@artgod/shared/types/trait-catalog';
import CollectionViewPicker from './components/CollectionViewPicker.svelte';
import { BIDDING_E2E_COLLECTION } from './e2e/bidding-automation-fixtures';
import {
	BIDDING_AUTOMATION_DRAFT_TARGET_TYPE as Target,
	BIDDING_AUTOMATION_FILTER_SELECTION_STATE as State,
	BIDDING_AUTOMATION_FILTER_TARGET_INTENT as Intent,
	BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE as Source,
	BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE as Surface,
	buildBiddingAutomationResolvedTokenFilterSnapshot,
	buildBiddingAutomationDraftFromSelection,
	canDraftNativeBidScope
} from './bidding-automation';
import {
	COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE as Join,
	TRAIT_FILTER_DISPLAY_KIND as Display,
	TRADING_BIDDING_BID_SCOPE_KIND as Scope
} from '@artgod/shared/types';
import {
	COLLECTION_VIEW_PICKER_QUERY,
	resolveCollectionViewPickerDestination,
	selectCollectionViewHref
} from './collection-view';

const match = vi.fn<typeof import('$app/paths').match>();

const view = {
	id: 'example',
	label: 'Example',
	generation: 3,
	ready: 2,
	classified: 2,
	parent: null,
	pinnedTraits: [{ key: 'scope', value: 'one' }],
	activeMapperVersion: 'test',
	availableMapperVersion: 'test'
};

it('orders sibling blocks by label while preserving case variants and their distinct option values', () => {
	const parent = { id: 'artworks', label: 'Artworks' };
	const views = ['Zebra', 'apple', 'Apple', 'BRAVO', 'apricot'].map((label, index) => ({
		...view,
		id: `block-${index}`,
		label,
		parent
	}));
	const { body } = render(CollectionViewPicker, {
		props: {
			context: {
				chainRef: 'chain',
				collectionRef: 'collection',
				basePath: '/chain/collection',
				discovery: {
					collection: BIDDING_E2E_COLLECTION,
					required: true,
					selectedViewId: views[2].id,
					views
				}
			},
			path: '/chain/collection',
			query: new URLSearchParams()
		}
	});
	const options = [...body.matchAll(/<option value="(block-\d+)"[^>]*>([^<]+)<\/option>/g)];
	expect(body).toMatch(/<option value="block-2" selected[^>]*>Apple<\/option>/);
	expect(options.map(([, id, label]) => [id, label])).toEqual([
		['block-1', 'apple'],
		['block-2', 'Apple'],
		['block-4', 'apricot'],
		['block-3', 'BRAVO'],
		['block-0', 'Zebra']
	]);
});

it.each([
	{ groupId: null, selection: 'All' },
	{ groupId: 'family', selection: 'Family' }
])(
	'shows the selected aggregate and makes the other aggregate reachable',
	({ groupId, selection }) => {
		const { body } = render(CollectionViewPicker, {
			props: {
				context: {
					basePath: '/chain/collection',
					chainRef: 'chain',
					collectionRef: 'collection',
					discovery: {
						collection: BIDDING_E2E_COLLECTION,
						required: true,
						selectedViewId: null,
						...(groupId && { selectedGroupId: groupId }),
						views: [{ ...view, parent: { id: 'family', label: 'Family' } }]
					}
				},
				path: '/chain/collection/activity',
				query: new URLSearchParams('kind=sales')
			}
		});
		expect(body).toContain(`aria-current="true">${selection}</span>`);
		if (groupId) {
			expect(body).toContain('href="/chain/collection/activity?kind=sales">All</a>');
			expect(body).toMatch(/<option value="" selected[^>]*>All blocks<\/option>/);
		} else {
			expect(body).toContain(`${TRAIT_CATALOG_QUERY.Group}=family">Family</a>`);
			expect(body).not.toContain('<select');
		}
	}
);

it.each([
	{ missing: 'field binding', pinnedTraits: view.pinnedTraits, fieldBound: false },
	{ missing: 'view pin', pinnedTraits: [], fieldBound: true }
])('blocks a trait bid without a $missing', ({ pinnedTraits, fieldBound }) => {
	const selected = { key: 'Decoration', value: 'blue' };
	const filter = buildBiddingAutomationResolvedTokenFilterSnapshot({
		collectionView: {
			chainRef: 'chain',
			collectionRef: 'collection',
			basePath: '/chain/collection',
			discovery: {
				collection: BIDDING_E2E_COLLECTION,
				required: true,
				selectedViewId: view.id,
				views: [{ ...view, pinnedTraits }]
			}
		},
		source: Surface.TokenBrowser,
		selectedTraits: [selected],
		facets: [
			{
				key: selected.key,
				displayKind: Display.Set,
				minValue: null,
				maxValue: null,
				values: [
					{
						value: selected.value,
						tokenCount: 2,
						marketplaceBiddingSupported: fieldBound,
						native: fieldBound ? selected : null
					}
				]
			}
		],
		selectedTraitRanges: [],
		traitJoinMode: Join.And
	});
	expect(filter.nativeSelection).toBeNull();
	expect(filter.selectedTraits).toEqual([{ ...selected, marketplaceBiddingSupported: fieldBound }]);
	expect(
		buildBiddingAutomationDraftFromSelection({
			type: Source.FilteredTokens,
			targetIntent: Intent.TraitJob,
			filter,
			tokenCount: 2,
			state: { kind: State.Clean }
		})?.target.type
	).toBe(Target.UnsupportedTraitJob);
});

it('keeps aggregate token batches scoped and requires a complete native target for trait bids', () => {
	const pair = { key: 'Type', value: 'painting' };
	const group = { groupId: 'family' };
	for (const [scope, selected, expectedTarget] of [
		[null, [pair], Target.TraitJob],
		[null, [pair, { key: 'unknown', value: 'unknown' }], Target.UnsupportedTraitJob],
		[group, [pair], Target.UnsupportedTraitJob]
	] as const) {
		const filter = buildBiddingAutomationResolvedTokenFilterSnapshot({
			collectionView: {
				chainRef: 'chain',
				collectionRef: 'collection',
				basePath: '/chain/collection',
				discovery: {
					collection: BIDDING_E2E_COLLECTION,
					required: true,
					views: [],
					selectedViewId: null,
					...(scope && { selectedGroupId: scope.groupId })
				}
			},
			source: Surface.TokenBrowser,
			selectedTraits: [...selected],
			facets: [
				{
					key: pair.key,
					displayKind: Display.Set,
					minValue: null,
					maxValue: null,
					values: [{ value: pair.value, tokenCount: 2, marketplaceBiddingSupported: true }]
				}
			],
			selectedTraitRanges: [],
			traitJoinMode: Join.And
		});
		expect(filter.catalogScope ?? null).toEqual(scope);
		const selection = {
			type: Source.FilteredTokens,
			filter,
			tokenCount: 2,
			state: { kind: State.Clean }
		} as const;
		expect(
			buildBiddingAutomationDraftFromSelection({ ...selection, targetIntent: Intent.TraitJob })
				?.target.type
		).toBe(expectedTarget);
		expect(
			buildBiddingAutomationDraftFromSelection({ ...selection, targetIntent: Intent.TokenBatch })
				?.target.type
		).toBe(Target.FilteredTokenBatch);
	}
});

it('clears filters and cursor only when choosing a new view', () => {
	const url = new URL(
		selectCollectionViewHref(
			'/c',
			new URLSearchParams({
				traits: 'key:value',
				trait_ranges: 'x:1..2',
				cursor: 'old',
				mode: 'grid'
			}),
			view
		),
		'https://example.test'
	);
	expect([...url.searchParams.keys()].sort()).toEqual(
		[
			'mode',
			TRAIT_CATALOG_QUERY.View,
			TRAIT_CATALOG_QUERY.Catalog,
			TRAIT_CATALOG_QUERY.Generation
		].sort()
	);
	expect(url.searchParams.get(TRAIT_CATALOG_QUERY.View)).toBe(view.id);
});

it.each(['https://example.test', 'tauri://localhost'])(
	'resumes a bookmarked picker at the requested section and can switch across scopes on %s',
	async (origin) => {
		const basePath = '/chain/collection';
		const path = `${basePath}/activity`;
		const controls = new URLSearchParams(
			'sort=oldest&limit=25&media_mode=snapshot&cursor=old&traits=key:value'
		);
		match.mockResolvedValueOnce({
			id: '/[chain_ref]/[collection_ref]/activity',
			params: { chain_ref: 'chain', collection_ref: 'collection' }
		});
		const picker = new URL(basePath + '/views', origin);
		picker.searchParams.set(COLLECTION_VIEW_PICKER_QUERY.Section, path + '?' + controls);
		picker.searchParams.set(COLLECTION_VIEW_PICKER_QUERY.Group, 'art');
		const resume = await resolveCollectionViewPickerDestination(basePath, picker, match);
		expect(resume.path).toBe(path);
		const aggregate = selectCollectionViewHref(path, new URLSearchParams(resume.query), {
			groupId: 'art'
		});
		const all = selectCollectionViewHref(path, new URL(aggregate, origin).searchParams, null);
		expect(aggregate).toBe(
			`${path}?sort=oldest&limit=25&media_mode=snapshot&${TRAIT_CATALOG_QUERY.Group}=art`
		);
		expect(all).toBe(path + '?sort=oldest&limit=25&media_mode=snapshot');
	}
);

it('falls back to the collection for external, stale and recursive picker destinations', async () => {
	const basePath = '/chain/collection';
	const picker = new URL(`${basePath}/views`, 'https://example.test');
	const fallback = { path: basePath, query: '' };
	for (const section of [
		'//elsewhere.test/activity',
		'/chain/other/activity',
		'/chain/collection/../other'
	]) {
		picker.searchParams.set(COLLECTION_VIEW_PICKER_QUERY.Section, section);
		expect(await resolveCollectionViewPickerDestination(basePath, picker, match)).toEqual(fallback);
	}
	picker.searchParams.set(COLLECTION_VIEW_PICKER_QUERY.Section, `${basePath}/missing/route`);
	match.mockResolvedValueOnce(null);
	expect(await resolveCollectionViewPickerDestination(basePath, picker, match)).toEqual(fallback);
	picker.searchParams.set(COLLECTION_VIEW_PICKER_QUERY.Section, `${basePath}/views?limit=2`);
	match.mockResolvedValueOnce({
		id: '/[chain_ref]/[collection_ref]/views',
		params: { chain_ref: 'chain', collection_ref: 'collection' }
	});
	expect(await resolveCollectionViewPickerDestination(basePath, picker, match)).toEqual(fallback);
	picker.searchParams.set(COLLECTION_VIEW_PICKER_QUERY.Section, '/blockspace');
	match.mockResolvedValueOnce({ id: '/blockspace', params: {} });
	expect(await resolveCollectionViewPickerDestination('/', picker, match)).toEqual({
		path: '/',
		query: ''
	});
});

it('keeps finite and numeric offer scopes out of exact trait drafts', () => {
	const scope = {
		kind: Scope.Trait,
		label: 'scope',
		tokenId: null,
		traits: [{ type: 'scope', value: 'one' }]
	};
	expect(canDraftNativeBidScope({ ...scope, encodedTokenIds: '1:3' })).toBe(false);
	expect(canDraftNativeBidScope({ ...scope, kind: Scope.TokenSet })).toBe(false);
	expect(canDraftNativeBidScope({ ...scope, traits: [{ type: 'level', min: 1, max: 2 }] })).toBe(
		false
	);
	expect(canDraftNativeBidScope({ ...scope, encodedTokenIds: '*' })).toBe(true);
});
