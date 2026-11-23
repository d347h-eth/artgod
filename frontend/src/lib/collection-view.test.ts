import { expect, it } from 'vitest';
import { TRAIT_CATALOG_QUERY } from '@artgod/shared/types/trait-catalog';
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
import { selectCollectionViewHref } from './collection-view';

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

it('retains the complete token selection and blocks a native draft with an unbound field', () => {
	const selected = { key: 'Decoration', value: 'blue' };
	const filter = buildBiddingAutomationResolvedTokenFilterSnapshot({
		view,
		source: Surface.TokenBrowser,
		selectedTraits: [selected],
		facets: [
			{
				key: selected.key,
				displayKind: Display.Set,
				minValue: null,
				maxValue: null,
				values: [
					{ value: selected.value, tokenCount: 2, marketplaceBiddingSupported: false, native: null }
				]
			}
		],
		selectedTraitRanges: [],
		traitJoinMode: Join.And
	});
	expect(filter.nativeSelection).toBeNull();
	expect(filter.selectedTraits).toEqual([{ ...selected, marketplaceBiddingSupported: false }]);
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
		['mode', ...Object.values(TRAIT_CATALOG_QUERY)].sort()
	);
	expect(url.searchParams.get(TRAIT_CATALOG_QUERY.View)).toBe(view.id);
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
