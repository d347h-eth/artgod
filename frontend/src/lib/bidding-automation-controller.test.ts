import { get } from 'svelte/store';
import { describe, expect, it } from 'vitest';
import {
	BIDDING_AUTOMATION_FILTER_SELECTION_STATE,
	BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE
} from '$lib/bidding-automation';
import { createBiddingAutomationController } from '$lib/bidding-automation-controller';

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
