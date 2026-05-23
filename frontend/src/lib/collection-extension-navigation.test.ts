import type { Component } from 'svelte';
import { describe, expect, it } from 'vitest';
import {
	COLLECTION_EXTENSION_NAVIGATION_TAB_TARGET_KIND,
	collectionExtensionNavigationTabActivityEvent,
	collectionExtensionNavigationTabPage,
	registerCollectionNavigationGroup,
	resolveCollectionExtensionNavigationGroups
} from '$lib/collection-extension-navigation';
import {
	registerCollectionExtensionPage,
	type CollectionExtensionPageProps
} from '$lib/collection-extension-pages';

const EmptyExtensionPage = {} as Component<CollectionExtensionPageProps>;

describe('resolveCollectionExtensionNavigationGroups', () => {
	it('resolves extension page tabs only for enabled and registered collection pages', () => {
		registerCollectionExtensionPage({
			extensionKey: 'test-page-extension',
			pageRef: 'catalog',
			label: 'catalog',
			Page: EmptyExtensionPage
		});
		registerCollectionNavigationGroup({
			id: 'test-page-navigation',
			label: 'pages',
			tabs: [
				{
					id: 'catalog',
					label: 'catalog',
					target: {
						kind: COLLECTION_EXTENSION_NAVIGATION_TAB_TARGET_KIND.ExtensionPage,
						extensionKey: 'test-page-extension',
						pageRef: 'catalog'
					}
				}
			]
		});

		const groups = resolveCollectionExtensionNavigationGroups({
			activityEventFeeds: [],
			collectionExtensions: [{ key: 'test-page-extension' }]
		});
		const group = groups.find((entry) => entry.id === 'test-page-navigation');
		const tab = group?.tabs[0];

		expect(tab?.label).toBe('catalog');
		expect(collectionExtensionNavigationTabPage(tab!)).toMatchObject({
			extensionKey: 'test-page-extension',
			pageRef: 'catalog'
		});
		expect(collectionExtensionNavigationTabActivityEvent(tab!)).toBeNull();
	});

	it('hides extension page tabs when the page is not registered', () => {
		registerCollectionNavigationGroup({
			id: 'test-missing-page-navigation',
			label: 'missing pages',
			tabs: [
				{
					id: 'missing',
					label: 'missing',
					target: {
						kind: COLLECTION_EXTENSION_NAVIGATION_TAB_TARGET_KIND.ExtensionPage,
						extensionKey: 'test-missing-page-extension',
						pageRef: 'missing'
					}
				}
			]
		});

		const groups = resolveCollectionExtensionNavigationGroups({
			activityEventFeeds: [],
			collectionExtensions: [{ key: 'test-missing-page-extension' }]
		});

		expect(groups.some((group) => group.id === 'test-missing-page-navigation')).toBe(false);
	});

	it('keeps activity event tabs available independently from page registrations', () => {
		registerCollectionNavigationGroup({
			id: 'test-activity-navigation',
			label: 'events',
			tabs: [
				{
					id: 'dreams',
					label: 'dreams',
					target: {
						kind: COLLECTION_EXTENSION_NAVIGATION_TAB_TARGET_KIND.ActivityExtensionEvent,
						event: {
							extensionKey: 'test-event-extension',
							eventKey: 'dream'
						}
					}
				}
			]
		});

		const groups = resolveCollectionExtensionNavigationGroups({
			activityEventFeeds: [
				{
					extensionKey: 'test-event-extension',
					eventKey: 'dream',
					label: 'dream'
				}
			]
		});
		const group = groups.find((entry) => entry.id === 'test-activity-navigation');
		const tab = group?.tabs[0];

		expect(tab?.label).toBe('dreams');
		expect(collectionExtensionNavigationTabPage(tab!)).toBeNull();
		expect(collectionExtensionNavigationTabActivityEvent(tab!)).toMatchObject({
			extensionKey: 'test-event-extension',
			eventKey: 'dream'
		});
	});

});
