import { describe, expect, it } from 'vitest';
import {
	buildCollectionNavigation,
	resolveCollectionSectionShortcutHref
} from '$lib/collection-navigation';

describe('buildCollectionNavigation', () => {
	it('builds collection section hrefs from explicit navigation state', () => {
		const navigation = buildCollectionNavigation({
			basePath: '/ethereum/milady',
			mediaMode: 'artifact',
			selectedTraits: [{ key: 'Mode', value: 'Terrain' }],
			selectedTraitRanges: [],
			token: {
				limit: 25,
				displayMode: 'grid'
			},
			activity: {
				limit: 25,
				kind: 'sales'
			},
			bidding: {
				bidScope: 'traits',
				viewMode: 'bid_book'
			}
		});

		expect(navigation.hrefs.asks).toBe(
			'/ethereum/milady?limit=25&mode=grid&media_mode=artifact&traits=Mode%3ATerrain&token_status=listed'
		);
		expect(navigation.hrefs.offers).toBe(
			'/ethereum/milady/bidding?media_mode=artifact&bid_scope=traits&traits=Mode%3ATerrain'
		);
		expect(navigation.hrefs.tokens).toBe(
			'/ethereum/milady?limit=25&mode=grid&media_mode=artifact&traits=Mode%3ATerrain&token_status=all'
		);
		expect(navigation.hrefs.bidding).toBe(
			'/ethereum/milady/bidding?media_mode=artifact&bid_scope=traits&traits=Mode%3ATerrain&bidding_view=jobs'
		);
		expect(navigation.hrefs.activityKind('listings')).toBe(
			'/ethereum/milady/activity?limit=25&kind=listings&media_mode=artifact&traits=Mode%3ATerrain'
		);
		expect(navigation.hrefs.holders).toBe('/ethereum/milady/holders?media_mode=artifact');
	});
});

describe('resolveCollectionSectionShortcutHref', () => {
	it('maps collection numeric shortcuts to explicit main-nav targets', () => {
		const navigation = buildCollectionNavigation({
			basePath: '/ethereum/milady',
			mediaMode: 'artifact',
			selectedTraits: [],
			selectedTraitRanges: [],
			token: {
				limit: 25,
				displayMode: 'grid'
			},
			activity: {
				limit: 25,
				kind: 'sales'
			},
			bidding: {
				bidScope: 'traits'
			}
		});

		expect(resolveCollectionSectionShortcutHref(keyEvent('1'), navigation)).toBe(
			'/ethereum/milady?limit=25&mode=grid&media_mode=artifact&token_status=listed'
		);
		expect(resolveCollectionSectionShortcutHref(keyEvent('2'), navigation)).toBe(
			'/ethereum/milady/bidding?media_mode=artifact&bid_scope=traits'
		);
		expect(resolveCollectionSectionShortcutHref(keyEvent('3'), navigation)).toBe(
			'/ethereum/milady?limit=25&mode=grid&media_mode=artifact&token_status=all'
		);
		expect(resolveCollectionSectionShortcutHref(keyEvent('4'), navigation)).toBe(
			'/ethereum/milady/bidding?media_mode=artifact&bid_scope=traits&bidding_view=jobs'
		);
	});

	it('ignores shortcuts in text-entry targets and hidden bidding nav', () => {
		const navigation = buildCollectionNavigation({
			basePath: '/ethereum/milady',
			selectedTraits: [],
			selectedTraitRanges: [],
			bidding: {
				enabled: false
			}
		});

		expect(
			resolveCollectionSectionShortcutHref(keyEvent('1', elementLike('INPUT', 'text')), navigation)
		).toBeNull();
		expect(resolveCollectionSectionShortcutHref(keyEvent('2'), navigation)).toBeNull();
		expect(resolveCollectionSectionShortcutHref(keyEvent('4'), navigation)).toBeNull();
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
