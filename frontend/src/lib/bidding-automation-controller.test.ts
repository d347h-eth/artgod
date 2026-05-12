import { get } from 'svelte/store';
import { describe, expect, it } from 'vitest';
import {
	BIDDING_AUTOMATION_FILTER_SELECTION_STATE,
	BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE,
	type BiddingAutomationSelection
} from '$lib/bidding-automation';
import {
	biddingAutomationSelectionStateKey,
	biddingAutomationTokenSelectionState,
	createBiddingAutomationController,
	describeBiddingAutomationSelection
} from '$lib/bidding-automation-controller';

describe('createBiddingAutomationController', () => {
	it('stores clean filtered-token selections as all matching tokens', () => {
		const controller = createBiddingAutomationController();

		controller.selectFilteredTokens({
			tokenCount: 500,
			filter: {
				selectedTraits: [{ key: 'Mode', value: 'Terrain' }],
				selectedTraitRanges: [],
				traitJoinMode: 'and',
				tokenStatus: null,
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
		expect(controller.selectionSummary()).toBe('500 selected');
	});

	it('derives render state from explicit selection snapshots', () => {
		const selection: BiddingAutomationSelection = {
			type: BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.FilteredTokens,
			tokenCount: 69,
			filter: {
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

		expect(describeBiddingAutomationSelection(selection)).toBe('69 selected');
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
		expect(controller.selectionSummary()).toBe('2 selected');
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
		expect(controller.selectionSummary()).toBe('1 selected');
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
			tokenCount: 69,
			filter: {
				selectedTraits: [{ key: 'Mode', value: 'Terrain' }],
				selectedTraitRanges: [],
				traitJoinMode: 'and',
				tokenStatus: 'listed',
				makerAddress: null
			}
		});

		expect(controller.selectionSummary()).toBe('69 selected');
		expect(controller.tokenSelectionState('2').selected).toBe(true);
	});

	it('downgrades manual changes after select-all into visible token IDs', () => {
		const controller = createBiddingAutomationController();

		controller.selectFilteredTokens({
			tokenCount: 500,
			filter: {
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
