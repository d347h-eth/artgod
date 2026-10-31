import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import { readable } from 'svelte/store';
import { COLLECTION_MEDIA_MODE_OPTIONS, COLLECTION_MEDIA_MODES } from '@artgod/shared/extensions';
import type {
	TokenPreviewController,
	TokenPreviewState
} from '$lib/components/token-preview-controller';
import {
	TOKEN_PREVIEW_CONTEXT_KIND,
	TOKEN_PREVIEW_STATUS
} from '$lib/components/token-preview-controller';

const { getTokenPreviewControllerMock } = vi.hoisted(() => ({
	getTokenPreviewControllerMock: vi.fn()
}));

vi.mock('$lib/components/token-preview-controller', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/components/token-preview-controller')>();
	return {
		...actual,
		getTokenPreviewController: getTokenPreviewControllerMock
	};
});

import TokenPreviewOverlay from './TokenPreviewOverlay.svelte';
import { TOKEN_PREVIEW_TRAITS_MODE } from '$lib/token-preview-traits';

const TEST_MEDIA_VARIANT = {
	Artifact: { key: 'test-artifact', label: 'test artifact' }
} as const;
const TEST_EVENT_MODE = {
	Captured: 'captured-event',
	Network: 'network-event'
} as const;

describe('TokenPreviewOverlay', () => {
	beforeEach(() => {
		getTokenPreviewControllerMock.mockReset();
	});

	it('keeps the initial loading state inside the centered preview box', () => {
		getTokenPreviewControllerMock.mockReturnValue(
			previewController(
				previewState({
					status: TOKEN_PREVIEW_STATUS.Loading,
					iframeSource: null
				})
			)
		);

		const { body } = render(TokenPreviewOverlay);

		expect(body).toContain('class="token-preview-box"');
		expect(body).toContain('aria-label="loading preview"');
		expect(body).not.toContain('token-preview-network-spinner');
	});

	it('renders source before version for a single-source token with variants', () => {
		getTokenPreviewControllerMock.mockReturnValue(
			previewController(
				previewState({
					selectedMediaVariant: TEST_MEDIA_VARIANT.Artifact.key,
					defaultMediaVariant: TEST_MEDIA_VARIANT.Artifact.key,
					availableMediaVariants: [TEST_MEDIA_VARIANT.Artifact]
				})
			)
		);

		const { body } = render(TokenPreviewOverlay);

		const sourceRowIndex = body.indexOf('aria-label="Preview source"');
		const versionRowIndex = body.indexOf('aria-label="Preview media version"');
		expect(sourceRowIndex).toBeGreaterThanOrEqual(0);
		expect(versionRowIndex).toBeGreaterThan(sourceRowIndex);
		expect(body).toContain('>snapshot</button>');
		expect(body).toContain(`>${TEST_MEDIA_VARIANT.Artifact.label}</button>`);
	});

	it('keeps activity event modes in one flat row without token version controls', () => {
		getTokenPreviewControllerMock.mockReturnValue(
			previewController(
				previewState({
					selectedMediaMode: TEST_EVENT_MODE.Captured,
					availableMediaModes: [
						{ key: TEST_EVENT_MODE.Captured, label: 'captured' },
						{ key: TEST_EVENT_MODE.Network, label: 'network' }
					],
					availableMediaVariants: [TEST_MEDIA_VARIANT.Artifact],
					previewContext: {
						kind: TOKEN_PREVIEW_CONTEXT_KIND.ActivityEvent,
						activityId: 42
					}
				})
			)
		);

		const { body } = render(TokenPreviewOverlay);

		expect(body).toContain('aria-label="Preview event mode"');
		expect(body).not.toContain('aria-label="Preview source"');
		expect(body).not.toContain('aria-label="Preview media version"');
		expect(body).not.toContain('token-preview-traits-output');
	});

	it('renders the configured summary above traits and navigation without filter links', () => {
		getTokenPreviewControllerMock.mockReturnValue(
			previewController(
				previewState({
					traitSummary: 'Terrain / 7\nForest',
					canNavigateNext: true
				})
			)
		);
		const { body } = render(TokenPreviewOverlay);
		expect(body).toContain('Terrain / 7\nForest');
		expect(body.indexOf('Token traits')).toBeLessThan(body.indexOf('>traits</button>'));
		expect(body.indexOf('>traits</button>')).toBeLessThan(body.indexOf('Preview navigation'));
		expect(body).not.toContain('<a ');
	});

	it('clips trait text without changing the full filter identity or rendering metadata HTML', () => {
		getTokenPreviewControllerMock.mockReturnValue(
			previewController(
				previewState({
					traitDisplay: { mode: TOKEN_PREVIEW_TRAITS_MODE.Page, page: 0 },
					attributes: [{ key: 'Long trait label', value: '<script>some very long value</script>' }]
				})
			)
		);
		const { body } = render(TokenPreviewOverlay);
		expect(body).toContain('Long trait');
		expect(body).toContain('&lt;script>some ve');
		expect(body).toContain('Long+trait+label%3A%3Cscript%3Esome+very+long+value%3C%2Fscript%3E');
		expect(body).not.toContain('<script>');
		expect(body).not.toContain('…');
	});
});

function previewState(overrides: Partial<TokenPreviewState>): TokenPreviewState {
	return {
		open: true,
		status: TOKEN_PREVIEW_STATUS.Ready,
		iframeSource: { kind: 'src', value: 'https://example.com/token.html' },
		tokenId: '1',
		chainRef: 'ethereum',
		collectionRef: 'terraforms',
		selectedMediaMode: COLLECTION_MEDIA_MODES.Snapshot,
		availableMediaModes: [COLLECTION_MEDIA_MODE_OPTIONS.Snapshot],
		mediaPreference: null,
		selectedMediaVariant: null,
		defaultMediaVariant: null,
		availableMediaVariants: [],
		requestedMediaVariant: null,
		previewContext: null,
		scalePercent: 100,
		attributes: [],
		traitSummary: null,
		traitDisplay: { mode: TOKEN_PREVIEW_TRAITS_MODE.Summary },
		aspectRatio: 1,
		errorMessage: null,
		canNavigatePrevious: false,
		canNavigateNext: false,
		...overrides
	};
}

function previewController(state: TokenPreviewState): TokenPreviewController {
	return {
		state: readable(state),
		openTokenPreview: vi.fn(),
		setTokenPreviewMediaMode: vi.fn(),
		setTokenPreviewMediaVariant: vi.fn(),
		cycleTokenPreviewMediaMode: vi.fn(),
		cycleTokenPreviewMediaVariant: vi.fn(),
		cycleTokenPreviewTraits: vi.fn(),
		retryTokenPreview: vi.fn(),
		navigatePreviousTokenPreview: vi.fn(),
		navigateNextTokenPreview: vi.fn(),
		closeTokenPreview: vi.fn(),
		onWindowKeydown: vi.fn(),
		tokenPreviewAriaLabel: vi.fn((tokenId: string) => `preview token ${tokenId}`)
	};
}
