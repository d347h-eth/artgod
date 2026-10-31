import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_STORAGE_KEYS } from '$lib/local-storage-keys';
import { parseSelectedTraits } from '$lib/trait-filters';
import {
	clampTokenPreviewTraitDisplay,
	clipTokenPreviewTraitText,
	nextTokenPreviewTraitDisplay,
	tokenPreviewTraitPage,
	TOKEN_PREVIEW_TRAITS_LIMITS,
	TOKEN_PREVIEW_TRAITS_MODE,
	type TokenPreviewTraitDisplay
} from './token-preview-traits';
import {
	buildTokenPreviewTraitHref,
	persistTokenPreviewTraitDisplay,
	readTokenPreviewTraitDisplay
} from './token-preview-traits-browser';

vi.mock('$app/env', () => ({ browser: true }));

describe('fullscreen preview traits', () => {
	let storage: Map<string, string>;
	beforeEach(() => {
		storage = new Map();
		vi.stubGlobal('window', {
			localStorage: {
				getItem: (key: string) => storage.get(key) ?? null,
				setItem: (key: string, value: string) => storage.set(key, value)
			}
		});
	});
	afterEach(() => vi.unstubAllGlobals());

	it.each([0, 1, 20, 21, 40, 41])(
		'cycles every page once before empty and summary for %i traits',
		(count) => {
			const attributes = Array.from({ length: count }, (_, index) => ({
				key: `key ${index}`,
				value: `${index}`
			}));
			let display: TokenPreviewTraitDisplay = { mode: TOKEN_PREVIEW_TRAITS_MODE.Summary };
			const shown = [];
			for (
				let page = 0;
				page < Math.ceil(count / TOKEN_PREVIEW_TRAITS_LIMITS.RowsPerPage);
				page += 1
			) {
				display = nextTokenPreviewTraitDisplay(display, count);
				expect(display).toEqual({ mode: TOKEN_PREVIEW_TRAITS_MODE.Page, page });
				const rows = tokenPreviewTraitPage(attributes, display);
				expect(rows.length).toBeLessThanOrEqual(TOKEN_PREVIEW_TRAITS_LIMITS.RowsPerPage);
				shown.push(...rows);
			}
			expect(shown).toEqual(attributes);
			display = nextTokenPreviewTraitDisplay(display, count);
			expect(display.mode).toBe(TOKEN_PREVIEW_TRAITS_MODE.Hidden);
			expect(tokenPreviewTraitPage(attributes, display)).toEqual([]);
			expect(nextTokenPreviewTraitDisplay(display, count).mode).toBe(
				TOKEN_PREVIEW_TRAITS_MODE.Summary
			);
		}
	);

	it('restores the exact page and clamps only to the current token pages', () => {
		const display = { mode: TOKEN_PREVIEW_TRAITS_MODE.Page, page: 4 } as const;
		persistTokenPreviewTraitDisplay(display);
		expect(readTokenPreviewTraitDisplay()).toEqual(display);
		expect(clampTokenPreviewTraitDisplay(display, 101)).toEqual(display);
		expect(clampTokenPreviewTraitDisplay(display, 21)).toEqual({
			mode: TOKEN_PREVIEW_TRAITS_MODE.Page,
			page: 1
		});
		expect(clampTokenPreviewTraitDisplay(display, 0)).toEqual({
			mode: TOKEN_PREVIEW_TRAITS_MODE.Hidden
		});
	});

	it.each([TOKEN_PREVIEW_TRAITS_MODE.Summary, TOKEN_PREVIEW_TRAITS_MODE.Hidden])(
		'restores %s independently of the number of traits',
		(mode) => {
			persistTokenPreviewTraitDisplay({ mode });
			expect(clampTokenPreviewTraitDisplay(readTokenPreviewTraitDisplay(), 0)).toEqual({ mode });
		}
	);

	it.each([
		'broken',
		'null',
		'{}',
		'{"mode":"unknown"}',
		'{"mode":"page","page":-1}',
		'{"mode":"page","page":1.5}',
		'{"mode":"page","page":"2"}'
	])('recovers from invalid storage %s', (raw) => {
		storage.set(LOCAL_STORAGE_KEYS.tokenPreviewTraitDisplay, raw);
		expect(readTokenPreviewTraitDisplay()).toEqual({ mode: TOKEN_PREVIEW_TRAITS_MODE.Summary });
	});

	it('keeps the current display usable when local storage is blocked', () => {
		vi.stubGlobal('window', {
			get localStorage() {
				throw new Error('blocked');
			}
		});
		const hidden = { mode: TOKEN_PREVIEW_TRAITS_MODE.Hidden } as const;
		expect(() => persistTokenPreviewTraitDisplay(hidden)).not.toThrow();
		expect(readTokenPreviewTraitDisplay(hidden)).toEqual(hidden);
	});

	it('cuts text without ellipses, splitting Unicode, or allowing additional lines', () => {
		expect(
			clipTokenPreviewTraitText('abcdefghijk', TOKEN_PREVIEW_TRAITS_LIMITS.KeyCharacters)
		).toBe('abcdefghij');
		expect(
			clipTokenPreviewTraitText('1234567890123456', TOKEN_PREVIEW_TRAITS_LIMITS.ValueCharacters)
		).toBe('123456789012345');
		expect(clipTokenPreviewTraitText('🌲🌳🌴', 2)).toBe('🌲🌳');
		expect(clipTokenPreviewTraitText('a\nb\tc', 5)).toBe('a b c');
	});

	it('filters with the entire trait identity and preserves media selection', () => {
		const trait = { key: 'Long trait label', value: 'A value far beyond the display limit' };
		const href = buildTokenPreviewTraitHref({
			chainRef: 'ethereum',
			collectionRef: 'collection',
			trait,
			mediaMode: 'snapshot',
			mediaPreference: null
		});
		const url = new URL(href!, 'https://example.test');
		expect(url.pathname).toBe('/ethereum/collection');
		expect(parseSelectedTraits(url.searchParams)).toEqual([trait]);
		expect(url.searchParams.get('media_mode')).toBe('snapshot');
		expect(url.searchParams.get('token_status')).toBe('all');
		expect(
			buildTokenPreviewTraitHref({
				chainRef: 'ethereum',
				collectionRef: 'collection',
				trait: { key: 'key', value: 'ambiguous,value' },
				mediaMode: 'snapshot',
				mediaPreference: null
			})
		).toBeNull();
	});
});
