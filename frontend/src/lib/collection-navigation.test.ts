import { describe, expect, it } from 'vitest';
import {
	buildCollectionNavigation,
	resolveCollectionSectionShortcutHref
} from '$lib/collection-navigation';
import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import { COLLECTION_EXTENSION_NAVIGATION_TAB_TARGET_KIND } from '$lib/collection-extension-navigation';

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
				bidScope: 'traits'
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
		expect(navigation.hrefs.activityKind('listings')).toBe(
			'/ethereum/milady/activity?limit=25&kind=listings&media_mode=artifact&traits=Mode%3ATerrain'
		);
		expect(
			navigation.hrefs.extensionPage({
				kind: COLLECTION_EXTENSION_NAVIGATION_TAB_TARGET_KIND.ExtensionPage,
				extensionKey: 'terraforms',
				pageRef: 'hypercastle'
			})
		).toBe('/ethereum/milady/extensions/terraforms/hypercastle');
		expect(
			navigation.hrefs.extensionPage({
				kind: COLLECTION_EXTENSION_NAVIGATION_TAB_TARGET_KIND.ExtensionPage,
				extensionKey: 'terraforms',
				pageRef: 'hypercastle',
				preserveMediaMode: true
			})
		).toBe('/ethereum/milady/extensions/terraforms/hypercastle?media_mode=artifact');
		expect(navigation.hrefs.holders).toBe('/ethereum/milady/holders?media_mode=artifact');
		expect(navigation.hrefs.blockspace).toBe('/ethereum/blockspace?collection=milady');
	});

	it('can hide blockspace navigation explicitly', () => {
		const navigation = buildCollectionNavigation({
			basePath: '/ethereum/milady',
			selectedTraits: [],
			selectedTraitRanges: [],
			blockspace: {
				enabled: false
			}
		});

		expect(navigation.showBlockspace).toBe(false);
		expect(navigation.hrefs.blockspace).toBeNull();
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
		expect(resolveCollectionSectionShortcutHref(keyEvent('4'), navigation)).toBeNull();
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
		expect(
			resolveCollectionSectionShortcutHref(keyEvent('1', elementLike('INPUT', 'checkbox')), navigation)
		).toBe(`/ethereum/milady?limit=${DEFAULT_PAGE_LIMIT}&mode=grid&token_status=listed`);
		expect(resolveCollectionSectionShortcutHref(keyEvent('2'), navigation)).toBeNull();
		expect(resolveCollectionSectionShortcutHref(keyEvent('4'), navigation)).toBeNull();
	});

	it('can hide offers navigation explicitly', () => {
		const navigation = buildCollectionNavigation({
			basePath: '/',
			mediaMode: 'artifact',
			selectedTraits: [],
			selectedTraitRanges: [],
			bidding: {
				showOffers: false,
				bidScope: 'traits'
			}
		});

		expect(navigation.showBiddingOffers).toBe(false);
		expect(navigation.hrefs.offers).toBeNull();
		expect(resolveCollectionSectionShortcutHref(keyEvent('2'), navigation)).toBeNull();
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
