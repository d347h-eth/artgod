import { describe, expect, it } from 'vitest';
import {
	resolveCollectionSectionShortcutHref,
	type CollectionSectionNavigationConfig
} from '$lib/components/collection-section-navigation';

const navigationConfig: CollectionSectionNavigationConfig = {
	tokensBasePath: '/ethereum/milady',
	tokensQuery: new URLSearchParams('limit=25&mode=grid&media_mode=artifact'),
	activitiesBasePath: '/ethereum/milady',
	activitiesQuery: new URLSearchParams('limit=25&kind=sales&media_mode=artifact'),
	biddingBasePath: '/ethereum/milady',
	biddingQuery: new URLSearchParams('media_mode=artifact&bid_scope=traits')
};

describe('resolveCollectionSectionShortcutHref', () => {
	it('maps collection numeric shortcuts to explicit main-nav targets', () => {
		expect(resolveCollectionSectionShortcutHref(keyEvent('1'), navigationConfig)).toBe(
			'/ethereum/milady?limit=25&mode=grid&media_mode=artifact&token_status=listed'
		);
		expect(resolveCollectionSectionShortcutHref(keyEvent('2'), navigationConfig)).toBe(
			'/ethereum/milady/bidding?media_mode=artifact&bid_scope=traits'
		);
		expect(resolveCollectionSectionShortcutHref(keyEvent('3'), navigationConfig)).toBe(
			'/ethereum/milady?limit=25&mode=grid&media_mode=artifact&token_status=all'
		);
		expect(resolveCollectionSectionShortcutHref(keyEvent('4'), navigationConfig)).toBe(
			'/ethereum/milady/bidding?media_mode=artifact&bid_scope=traits&bidding_view=jobs'
		);
	});

	it('ignores shortcuts in text-entry targets and hidden bidding nav', () => {
		expect(
			resolveCollectionSectionShortcutHref(keyEvent('1', elementLike('INPUT', 'text')), navigationConfig)
		).toBeNull();
		expect(
			resolveCollectionSectionShortcutHref(keyEvent('2'), {
				...navigationConfig,
				showBidding: false
			})
		).toBeNull();
		expect(
			resolveCollectionSectionShortcutHref(keyEvent('4'), {
				...navigationConfig,
				showBidding: false
			})
		).toBeNull();
	});
});

function keyEvent(key: string, target: EventTarget | null = null): KeyboardEvent {
	return {
		key,
		target,
		defaultPrevented: false,
		metaKey: false,
		ctrlKey: false,
		altKey: false
	} as unknown as KeyboardEvent;
}

function elementLike(tagName: string, type = ''): EventTarget {
	return {
		tagName,
		type,
		isContentEditable: false
	} as unknown as EventTarget;
}
