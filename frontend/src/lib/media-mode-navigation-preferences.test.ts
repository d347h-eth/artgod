import { describe, expect, it } from 'vitest';
import { COLLECTION_MEDIA_MODES } from '@artgod/shared/extensions';
import type { ApiCollectionMediaMode } from '$lib/api-types';
import {
	clearCollectionMediaModeNavigationPreference,
	collectionMediaModePreferenceScope,
	readCollectionMediaModeNavigationPreference,
	resolvePreferredCollectionMediaModeHref,
	writeCollectionMediaModeNavigationPreference
} from '$lib/media-mode-navigation-preferences';

const EXTENSION_MEDIA_MODE_KEY = 'live';
const UNAVAILABLE_MEDIA_MODE_KEY = 'token-local-mode';

const AVAILABLE_MEDIA_MODES: ApiCollectionMediaMode[] = [
	{ key: COLLECTION_MEDIA_MODES.Snapshot, label: COLLECTION_MEDIA_MODES.Snapshot },
	{ key: EXTENSION_MEDIA_MODE_KEY, label: EXTENSION_MEDIA_MODE_KEY }
];

describe('collection media mode navigation preferences', () => {
	it('stores and reads an API-provided collection media mode by collection scope', () => {
		const storage = new MemoryStorage();
		const scopePath = collectionMediaModePreferenceScope({
			chainRef: 'ethereum',
			collectionRef: 'terraforms'
		});

		writeCollectionMediaModeNavigationPreference({
			scopePath,
			mediaMode: EXTENSION_MEDIA_MODE_KEY,
			availableModes: AVAILABLE_MEDIA_MODES,
			storage
		});

		expect(
			readCollectionMediaModeNavigationPreference({
				scopePath,
				availableModes: AVAILABLE_MEDIA_MODES,
				storage
			})
		).toBe(EXTENSION_MEDIA_MODE_KEY);
	});

	it('does not store modes outside the current collection available-mode list', () => {
		const storage = new MemoryStorage();

		writeCollectionMediaModeNavigationPreference({
			scopePath: '/ethereum/terraforms',
			mediaMode: UNAVAILABLE_MEDIA_MODE_KEY,
			availableModes: AVAILABLE_MEDIA_MODES,
			storage
		});

		expect(
			readCollectionMediaModeNavigationPreference({
				scopePath: '/ethereum/terraforms',
				availableModes: AVAILABLE_MEDIA_MODES,
				storage
			})
		).toBeNull();
	});

	it('adds the stored media mode to navigation when the URL has no explicit mode', () => {
		const storage = new MemoryStorage();
		const scopePath = '/ethereum/terraforms';
		writeCollectionMediaModeNavigationPreference({
			scopePath,
			mediaMode: EXTENSION_MEDIA_MODE_KEY,
			availableModes: AVAILABLE_MEDIA_MODES,
			storage
		});

		expect(
			resolvePreferredCollectionMediaModeHref({
				url: new URL('https://artgod.test/ethereum/terraforms/bidding?bid_scope=collection'),
				scopePath,
				storage
			})
		).toBe('/ethereum/terraforms/bidding?bid_scope=collection&media_mode=live');
	});

	it('leaves explicit media mode URLs unchanged', () => {
		const storage = new MemoryStorage();
		writeCollectionMediaModeNavigationPreference({
			scopePath: '/ethereum/terraforms',
			mediaMode: EXTENSION_MEDIA_MODE_KEY,
			availableModes: AVAILABLE_MEDIA_MODES,
			storage
		});

		expect(
			resolvePreferredCollectionMediaModeHref({
				url: new URL('https://artgod.test/ethereum/terraforms?media_mode=snapshot'),
				scopePath: '/ethereum/terraforms',
				storage
			})
		).toBeNull();
	});

	it('clears only the selected collection scope', () => {
		const storage = new MemoryStorage();
		writeCollectionMediaModeNavigationPreference({
			scopePath: '/ethereum/terraforms',
			mediaMode: EXTENSION_MEDIA_MODE_KEY,
			availableModes: AVAILABLE_MEDIA_MODES,
			storage
		});
		writeCollectionMediaModeNavigationPreference({
			scopePath: '/ethereum/other',
			mediaMode: EXTENSION_MEDIA_MODE_KEY,
			availableModes: AVAILABLE_MEDIA_MODES,
			storage
		});

		clearCollectionMediaModeNavigationPreference({
			scopePath: '/ethereum/terraforms',
			storage
		});

		expect(
			readCollectionMediaModeNavigationPreference({
				scopePath: '/ethereum/terraforms',
				availableModes: AVAILABLE_MEDIA_MODES,
				storage
			})
		).toBeNull();
		expect(
			readCollectionMediaModeNavigationPreference({
				scopePath: '/ethereum/other',
				availableModes: AVAILABLE_MEDIA_MODES,
				storage
			})
		).toBe(EXTENSION_MEDIA_MODE_KEY);
	});
});

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem'> {
	readonly values = new Map<string, string>();

	getItem(key: string): string | null {
		return this.values.get(key) ?? null;
	}

	setItem(key: string, value: string): void {
		this.values.set(key, value);
	}
}
