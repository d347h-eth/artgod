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
		retryTokenPreview: vi.fn(),
		navigatePreviousTokenPreview: vi.fn(),
		navigateNextTokenPreview: vi.fn(),
		closeTokenPreview: vi.fn(),
		onWindowKeydown: vi.fn(),
		tokenPreviewAriaLabel: vi.fn((tokenId: string) => `preview token ${tokenId}`)
	};
}
