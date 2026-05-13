import { get } from 'svelte/store';
import { describe, expect, it } from 'vitest';
import {
	BIDDING_AUTOMATION_FILTER_SELECTION_STATE,
	BIDDING_AUTOMATION_FILTER_TARGET_INTENT,
	BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE,
	BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE,
	type BiddingAutomationSelection
} from '$lib/bidding-automation';
import {
	buildFilteredTokenBatchBiddingSelectionInput,
	buildFilteredTraitBiddingSelectionInput,
	biddingAutomationSelectionStateKey,
	biddingAutomationTokenSelectionState,
	createBiddingAutomationController,
	describeBiddingAutomationSelection,
	isCleanFilteredTokenBatchSelection,
	resolveTokenCardSelectionGesture
} from '$lib/bidding-automation-controller';

describe('createBiddingAutomationController', () => {
	it('builds shared filtered selection inputs for trait and token target controls', () => {
		const filter = {
			source: BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE.TokenOffers,
			selectedTraits: [{ key: 'Mode', value: 'Terrain' }],
			selectedTraitRanges: [],
			traitJoinMode: 'or' as const,
			tokenStatus: null,
			makerAddress: null
		};

		expect(buildFilteredTraitBiddingSelectionInput({ filter, tokenCount: 12 })).toEqual({
			targetIntent: BIDDING_AUTOMATION_FILTER_TARGET_INTENT.TraitJob,
			filter,
			tokenCount: 12
		});
		expect(buildFilteredTokenBatchBiddingSelectionInput({ filter, tokenCount: 12 })).toEqual({
			targetIntent: BIDDING_AUTOMATION_FILTER_TARGET_INTENT.TokenBatch,
			filter,
			tokenCount: 12
		});
	});

	it('stores clean filtered-token selections as all matching tokens', () => {
		const controller = createBiddingAutomationController();

		controller.selectFilteredTokens({
			targetIntent: BIDDING_AUTOMATION_FILTER_TARGET_INTENT.TokenBatch,
			tokenCount: 500,
			filter: {
				source: BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE.TokenBrowser,
				selectedTraits: [{ key: 'Mode', value: 'Terrain' }],
				selectedTraitRanges: [],
				traitJoinMode: 'and',
				tokenStatus: 'all',
				makerAddress: null
			}
		});

		const selection = get(controller.state).selection;
		expect(selection?.type).toBe(BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.FilteredTokens);
		if (selection?.type !== BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.FilteredTokens) {
			throw new Error('expected filtered token selection');
		}
		expect(selection.tokenCount).toBe(500);
		expect(selection.state.kind).toBe(BIDDING_AUTOMATION_FILTER_SELECTION_STATE.Clean);
		expect(isCleanFilteredTokenBatchSelection(selection)).toBe(true);
		expect(controller.selectionSummary()).toBe('500 tokens selected');
	});

	it('derives render state from explicit selection snapshots', () => {
		const selection: BiddingAutomationSelection = {
			type: BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.FilteredTokens,
			targetIntent: BIDDING_AUTOMATION_FILTER_TARGET_INTENT.TokenBatch,
			tokenCount: 69,
			filter: {
				source: BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE.TokenBrowser,
				selectedTraits: [{ key: 'Mode', value: 'Terrain' }],
				selectedTraitRanges: [],
				traitJoinMode: 'and',
				tokenStatus: 'listed',
				makerAddress: null
			},
			state: {
				kind: BIDDING_AUTOMATION_FILTER_SELECTION_STATE.Clean
			}
		};

		expect(describeBiddingAutomationSelection(selection)).toBe('69 tokens selected');
		const stateKey = biddingAutomationSelectionStateKey(selection);
		expect(stateKey).toContain('filter-clean');
		expect(biddingAutomationTokenSelectionState(selection, '123', stateKey).selected).toBe(true);
		expect(biddingAutomationTokenSelectionState(null, '123').selected).toBe(false);
	});

	it('adds explicit token selections instead of replacing the active selection', () => {
		const controller = createBiddingAutomationController();

		controller.toggleToken({
			tokenId: '1',
			gesture: 'ctrl_left_click',
			selected: true,
			visibleTokenIds: ['1', '2', '3']
		});
		controller.toggleToken({
			tokenId: '2',
			gesture: 'ctrl_left_click',
			selected: true,
			visibleTokenIds: ['1', '2', '3']
		});

		const selection = get(controller.state).selection;
		expect(selection?.type).toBe(BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.ExplicitTokens);
		if (selection?.type !== BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.ExplicitTokens) {
			throw new Error('expected explicit token selection');
		}
		expect(selection.tokenIds).toEqual(['1', '2']);
		expect(controller.selectionSummary()).toBe('2 tokens selected');
	});

	it('removes explicit token selections one by one', () => {
		const controller = createBiddingAutomationController();

		controller.toggleToken({
			tokenId: '1',
			gesture: 'ctrl_left_click',
			selected: true,
			visibleTokenIds: ['1', '2', '3']
		});
		controller.toggleToken({
			tokenId: '2',
			gesture: 'ctrl_left_click',
			selected: true,
			visibleTokenIds: ['1', '2', '3']
		});
		controller.toggleToken({
			tokenId: '1',
			gesture: 'ctrl_left_click',
			selected: false,
			visibleTokenIds: ['1', '2', '3']
		});

		const selection = get(controller.state).selection;
		expect(selection?.type).toBe(BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.ExplicitTokens);
		if (selection?.type !== BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.ExplicitTokens) {
			throw new Error('expected explicit token selection');
		}
		expect(selection.tokenIds).toEqual(['2']);
		expect(controller.selectionSummary()).toBe('1 token selected');
	});

	it('allows a later select-all action to replace an explicit token selection', () => {
		const controller = createBiddingAutomationController();

		controller.toggleToken({
			tokenId: '1',
			gesture: 'ctrl_left_click',
			selected: true,
			visibleTokenIds: ['1', '2', '3']
		});
		controller.clearSelection();
		controller.selectFilteredTokens({
			targetIntent: BIDDING_AUTOMATION_FILTER_TARGET_INTENT.TokenBatch,
			tokenCount: 69,
			filter: {
				source: BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE.TokenBrowser,
				selectedTraits: [{ key: 'Mode', value: 'Terrain' }],
				selectedTraitRanges: [],
				traitJoinMode: 'and',
				tokenStatus: 'listed',
				makerAddress: null
			}
		});

		expect(controller.selectionSummary()).toBe('69 tokens selected');
		expect(controller.tokenSelectionState('2').selected).toBe(true);
	});

	it('downgrades manual changes after select-all into visible token IDs', () => {
		const controller = createBiddingAutomationController();

		controller.selectFilteredTokens({
			targetIntent: BIDDING_AUTOMATION_FILTER_TARGET_INTENT.TokenBatch,
			tokenCount: 500,
			filter: {
				source: BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE.TokenBrowser,
				selectedTraits: [{ key: 'Mode', value: 'Terrain' }],
				selectedTraitRanges: [],
				traitJoinMode: 'and',
				tokenStatus: null,
				makerAddress: null
			}
		});
		controller.toggleToken({
			tokenId: '2',
			gesture: 'ctrl_left_click',
			selected: false,
			visibleTokenIds: ['1', '2', '3']
		});

		const selection = get(controller.state).selection;
		expect(selection?.type).toBe(BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.ExplicitTokens);
		if (selection?.type !== BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.ExplicitTokens) {
			throw new Error('expected explicit token selection');
		}
		expect(selection.tokenIds).toEqual(['1', '3']);
		expect(controller.tokenSelectionState('1').selected).toBe(true);
		expect(controller.tokenSelectionState('2').selected).toBe(false);
	});
});

describe('resolveTokenCardSelectionGesture', () => {
	it('preserves native browser new-tab behavior on token-card links', () => {
		const linkChild = {
			closest: (selector: string) => (selector === 'a[href]' ? {} : null)
		};
		const event = {
			type: 'click',
			button: 0,
			ctrlKey: true,
			target: linkChild
		} as unknown as MouseEvent;

		expect(resolveTokenCardSelectionGesture(event)).toBe(null);
	});

	it('keeps ctrl-click and middle-click selection on non-link card surfaces', () => {
		const mediaButton = {
			closest: () => null
		};
		const ctrlClick = {
			type: 'click',
			button: 0,
			ctrlKey: true,
			target: mediaButton
		} as unknown as MouseEvent;

		const middleClick = {
			type: 'auxclick',
			button: 1,
			target: mediaButton
		} as unknown as MouseEvent;

		expect(resolveTokenCardSelectionGesture(ctrlClick)).toBe('ctrl_left_click');
		expect(resolveTokenCardSelectionGesture(middleClick)).toBe('middle_click');
	});
});
