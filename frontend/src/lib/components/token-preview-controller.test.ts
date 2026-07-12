import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	COLLECTION_MEDIA_MODE_OPTIONS,
	COLLECTION_MEDIA_MODES,
	COLLECTION_MEDIA_PREFERENCE_VALUES,
	COLLECTION_MEDIA_QUERY_PARAMS
} from '@artgod/shared/extensions';
import { ACTIVITY_EVENT_PREVIEW_QUERY_PARAMS } from '@artgod/shared/types';
import { get } from 'svelte/store';
import type {
	ApiCollectionMediaPreference,
	ApiTokenMediaState,
	TokenPreviewApiResponse
} from '$lib/api-types';

const { getActivityEventPreviewMock, getTokenPreviewMock } = vi.hoisted(() => ({
	getActivityEventPreviewMock: vi.fn(),
	getTokenPreviewMock: vi.fn()
}));

vi.mock('$lib/backend-api', () => ({
	getActivityEventPreview: getActivityEventPreviewMock,
	getTokenPreview: getTokenPreviewMock
}));

import {
	createTokenPreviewController,
	TOKEN_PREVIEW_CONTEXT_KIND,
	TOKEN_PREVIEW_STATUS,
	tokenPreviewStyle
} from './token-preview-controller';

// Test-owned extension vocabulary exercises the generic controller boundary.
const TEST_MEDIA = {
	Source: { Live: 'network-source' },
	PreferenceLabel: 'prefer modern media',
	Variant: {
		ModernArtifact: 'modern-artifact',
		ModernAlternate: 'modern-alternate',
		Modern: 'modern',
		Middle: 'middle',
		Original: 'original'
	},
	EventMode: {
		Captured: 'captured-event',
		Network: 'network-event'
	}
} as const;

const SOURCE_OPTIONS = [
	COLLECTION_MEDIA_MODE_OPTIONS.Snapshot,
	{ key: TEST_MEDIA.Source.Live, label: TEST_MEDIA.Source.Live }
];
const SNAPSHOT_VARIANTS = [
	{ key: TEST_MEDIA.Variant.ModernArtifact, label: 'modern artifact' },
	{ key: TEST_MEDIA.Variant.ModernAlternate, label: 'modern alternate' },
	{ key: TEST_MEDIA.Variant.Original, label: 'original' }
];
const LIVE_VARIANTS = [
	{ key: TEST_MEDIA.Variant.Modern, label: 'modern' },
	{ key: TEST_MEDIA.Variant.Middle, label: 'middle' },
	{ key: TEST_MEDIA.Variant.Original, label: 'original' }
];
const ENABLED_V2_PREFERENCE: ApiCollectionMediaPreference = {
	label: TEST_MEDIA.PreferenceLabel,
	enabled: true,
	defaultEnabled: true
};
const DISABLED_V2_PREFERENCE: ApiCollectionMediaPreference = {
	...ENABLED_V2_PREFERENCE,
	enabled: false
};

describe('token-preview-controller', () => {
	beforeEach(() => {
		getActivityEventPreviewMock.mockReset();
		getTokenPreviewMock.mockReset();
	});

	it('adopts token-local media versions and omits the default preference query value', async () => {
		getTokenPreviewMock.mockResolvedValueOnce(
			tokenResponse({
				image: 'https://example.com/1.png',
				animationUrl: null,
				media: snapshotMedia()
			})
		);
		const controller = createTokenPreviewController();

		await controller.openTokenPreview({
			chainRef: 'ethereum',
			collectionRef: 'terraforms',
			tokenId: '1',
			selectedMediaMode: COLLECTION_MEDIA_MODES.Snapshot,
			availableMediaModes: SOURCE_OPTIONS,
			mediaPreference: ENABLED_V2_PREFERENCE
		});

		const query = tokenPreviewQuery(0);
		expect(query.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaMode)).toBe(
			COLLECTION_MEDIA_MODES.Snapshot
		);
		expect(query.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaPreference)).toBeNull();
		expect(query.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaVariant)).toBeNull();
		expect(get(controller.state)).toMatchObject({
			status: TOKEN_PREVIEW_STATUS.Ready,
			selectedMediaMode: COLLECTION_MEDIA_MODES.Snapshot,
			selectedMediaVariant: TEST_MEDIA.Variant.ModernArtifact,
			availableMediaVariants: SNAPSHOT_VARIANTS
		});
		expect(get(controller.state).iframeSource?.kind).toBe('srcdoc');
	});

	it('preserves an explicitly disabled V2 preference in preview requests', async () => {
		getTokenPreviewMock.mockResolvedValueOnce(
			tokenResponse({ media: snapshotMedia({ preference: DISABLED_V2_PREFERENCE }) })
		);
		const controller = createTokenPreviewController();

		await controller.openTokenPreview({
			chainRef: 'ethereum',
			collectionRef: 'terraforms',
			tokenId: '1',
			selectedMediaMode: COLLECTION_MEDIA_MODES.Snapshot,
			availableMediaModes: SOURCE_OPTIONS,
			mediaPreference: DISABLED_V2_PREFERENCE
		});

		expect(tokenPreviewQuery(0).get(COLLECTION_MEDIA_QUERY_PARAMS.MediaPreference)).toBe(
			COLLECTION_MEDIA_PREFERENCE_VALUES.Disabled
		);
	});

	it('cycles token media versions with V and keeps the source unchanged', async () => {
		getTokenPreviewMock
			.mockResolvedValueOnce(tokenResponse({ media: snapshotMedia() }))
			.mockResolvedValueOnce(
				tokenResponse({
					animationUrl: 'https://example.com/1-lost.html',
					media: snapshotMedia({
						selectedVariant: TEST_MEDIA.Variant.ModernAlternate,
						defaultVariant: TEST_MEDIA.Variant.ModernAlternate
					})
				})
			);
		const controller = createTokenPreviewController();
		await openSnapshot(controller);

		const event = keyboardEvent('V');
		controller.onWindowKeydown(event);
		await vi.waitFor(() => {
			expect(get(controller.state).selectedMediaVariant).toBe(TEST_MEDIA.Variant.ModernAlternate);
		});

		expect(event.preventDefault).toHaveBeenCalledOnce();
		const query = tokenPreviewQuery(1);
		expect(query.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaMode)).toBe(
			COLLECTION_MEDIA_MODES.Snapshot
		);
		expect(query.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaVariant)).toBe(
			TEST_MEDIA.Variant.ModernAlternate
		);
	});

	it('clears the selected version when switching media source', async () => {
		getTokenPreviewMock
			.mockResolvedValueOnce(tokenResponse({ media: snapshotMedia() }))
			.mockResolvedValueOnce(
				tokenResponse({
					animationUrl: 'https://example.com/1-live.html',
					media: liveMedia()
				})
			);
		const controller = createTokenPreviewController();
		await openSnapshot(controller);
		await controller.setTokenPreviewMediaMode(TEST_MEDIA.Source.Live);

		const query = tokenPreviewQuery(1);
		expect(query.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaMode)).toBe(TEST_MEDIA.Source.Live);
		expect(query.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaVariant)).toBeNull();
		expect(get(controller.state).selectedMediaVariant).toBe(TEST_MEDIA.Variant.Modern);
	});

	it('never caches or prefetches live media', async () => {
		getTokenPreviewMock
			.mockResolvedValueOnce(tokenResponse({ media: liveMedia() }))
			.mockResolvedValueOnce(tokenResponse({ media: liveMedia() }));
		const controller = createTokenPreviewController();
		const openLive = () =>
			controller.openTokenPreview({
				chainRef: 'ethereum',
				collectionRef: 'terraforms',
				tokenId: '1',
				selectedMediaMode: TEST_MEDIA.Source.Live,
				availableMediaModes: SOURCE_OPTIONS,
				mediaPreference: ENABLED_V2_PREFERENCE,
				adjacentTokenResolver: (step, tokenId) => (step === 1 && tokenId === '1' ? '2' : null)
			});

		await openLive();
		await flush();
		await openLive();
		await flush();

		expect(getTokenPreviewMock).toHaveBeenCalledTimes(2);
		expect(getTokenPreviewMock.mock.calls.every((call) => call[3] === '1')).toBe(true);
	});

	it('caches snapshot media separately by preference and version', async () => {
		getTokenPreviewMock
			.mockResolvedValueOnce(tokenResponse({ media: snapshotMedia() }))
			.mockResolvedValueOnce(
				tokenResponse({ media: snapshotMedia({ preference: DISABLED_V2_PREFERENCE }) })
			)
			.mockResolvedValueOnce(
				tokenResponse({
					media: snapshotMedia({
						selectedVariant: TEST_MEDIA.Variant.ModernAlternate
					})
				})
			);
		const controller = createTokenPreviewController();
		await openSnapshot(controller);
		await openSnapshot(controller);
		expect(getTokenPreviewMock).toHaveBeenCalledTimes(1);

		await controller.openTokenPreview({
			chainRef: 'ethereum',
			collectionRef: 'terraforms',
			tokenId: '1',
			selectedMediaMode: COLLECTION_MEDIA_MODES.Snapshot,
			availableMediaModes: SOURCE_OPTIONS,
			mediaPreference: DISABLED_V2_PREFERENCE
		});
		await controller.setTokenPreviewMediaVariant(TEST_MEDIA.Variant.ModernAlternate);

		expect(getTokenPreviewMock).toHaveBeenCalledTimes(3);
	});

	it('keeps current media visible while a source switch is in flight', async () => {
		const deferred = createDeferred<TokenPreviewApiResponse>();
		getTokenPreviewMock
			.mockResolvedValueOnce(tokenResponse({ media: snapshotMedia() }))
			.mockImplementationOnce(() => deferred.promise);
		const controller = createTokenPreviewController();
		await openSnapshot(controller);
		const currentIframeSource = get(controller.state).iframeSource;

		const switchPromise = controller.setTokenPreviewMediaMode(TEST_MEDIA.Source.Live);
		await flush();

		expect(get(controller.state)).toMatchObject({
			status: TOKEN_PREVIEW_STATUS.Loading,
			iframeSource: currentIframeSource,
			selectedMediaMode: TEST_MEDIA.Source.Live,
			selectedMediaVariant: null,
			availableMediaVariants: []
		});
		deferred.resolve(
			tokenResponse({
				animationUrl: 'https://example.com/1-live.html',
				media: liveMedia()
			})
		);
		await switchPromise;
		expect(get(controller.state)).toMatchObject({
			status: TOKEN_PREVIEW_STATUS.Ready,
			selectedMediaMode: TEST_MEDIA.Source.Live
		});
	});

	it('uses each adjacent token default version and retains navigation and scale hotkeys', async () => {
		getTokenPreviewMock
			.mockResolvedValueOnce(tokenResponse({ tokenId: '1', media: snapshotMedia() }))
			.mockResolvedValueOnce(
				tokenResponse({
					tokenId: '2',
					media: snapshotMedia({
						selectedVariant: TEST_MEDIA.Variant.Original,
						defaultVariant: TEST_MEDIA.Variant.Original
					})
				})
			);
		const controller = createTokenPreviewController();
		await controller.openTokenPreview({
			chainRef: 'ethereum',
			collectionRef: 'terraforms',
			tokenId: '1',
			selectedMediaMode: COLLECTION_MEDIA_MODES.Snapshot,
			availableMediaModes: SOURCE_OPTIONS,
			mediaPreference: ENABLED_V2_PREFERENCE,
			adjacentTokenResolver: adjacentPair
		});
		await flush();

		expect(tokenPreviewQuery(1).get(COLLECTION_MEDIA_QUERY_PARAMS.MediaVariant)).toBeNull();
		const shrinkEvent = keyboardEvent('-');
		controller.onWindowKeydown(shrinkEvent);
		expect(get(controller.state).scalePercent).toBe(95);
		controller.onWindowKeydown(keyboardEvent('+'));
		expect(get(controller.state).scalePercent).toBe(100);

		const nextEvent = keyboardEvent('d');
		controller.onWindowKeydown(nextEvent);
		await flush();
		expect(nextEvent.preventDefault).toHaveBeenCalledOnce();
		expect(getTokenPreviewMock).toHaveBeenCalledTimes(2);
		expect(get(controller.state)).toMatchObject({
			tokenId: '2',
			selectedMediaVariant: TEST_MEDIA.Variant.Original,
			requestedMediaVariant: null
		});
	});

	it('carries an explicit version to adjacent tokens while accepting backend fallback', async () => {
		getTokenPreviewMock
			.mockResolvedValueOnce(tokenResponse({ tokenId: '1', media: snapshotMedia() }))
			.mockResolvedValueOnce(tokenResponse({ tokenId: '2', media: snapshotMedia() }))
			.mockResolvedValueOnce(
				tokenResponse({
					tokenId: '1',
					media: snapshotMedia({
						selectedVariant: TEST_MEDIA.Variant.ModernAlternate
					})
				})
			)
			.mockResolvedValueOnce(
				tokenResponse({
					tokenId: '2',
					media: snapshotMedia({
						selectedVariant: TEST_MEDIA.Variant.Original,
						defaultVariant: TEST_MEDIA.Variant.Original,
						availableVariants: [{ key: TEST_MEDIA.Variant.Original, label: 'original' }]
					})
				})
			);
		const controller = createTokenPreviewController();
		await controller.openTokenPreview({
			chainRef: 'ethereum',
			collectionRef: 'terraforms',
			tokenId: '1',
			selectedMediaMode: COLLECTION_MEDIA_MODES.Snapshot,
			availableMediaModes: SOURCE_OPTIONS,
			mediaPreference: ENABLED_V2_PREFERENCE,
			adjacentTokenResolver: adjacentPair
		});
		await flush();
		await controller.setTokenPreviewMediaVariant(TEST_MEDIA.Variant.ModernAlternate);
		await flush();

		expect(tokenPreviewQuery(3).get(COLLECTION_MEDIA_QUERY_PARAMS.MediaVariant)).toBe(
			TEST_MEDIA.Variant.ModernAlternate
		);
		await controller.navigateNextTokenPreview();
		expect(getTokenPreviewMock).toHaveBeenCalledTimes(4);
		expect(get(controller.state)).toMatchObject({
			tokenId: '2',
			selectedMediaVariant: TEST_MEDIA.Variant.Original,
			requestedMediaVariant: TEST_MEDIA.Variant.ModernAlternate
		});
	});

	it('retries the failed preview request without closing the modal', async () => {
		getTokenPreviewMock
			.mockRejectedValueOnce(new Error('rpc unavailable'))
			.mockResolvedValueOnce(tokenResponse({ media: liveMedia() }));
		const controller = createTokenPreviewController();
		await controller.openTokenPreview({
			chainRef: 'ethereum',
			collectionRef: 'terraforms',
			tokenId: '1',
			selectedMediaMode: TEST_MEDIA.Source.Live,
			availableMediaModes: SOURCE_OPTIONS,
			mediaPreference: ENABLED_V2_PREFERENCE
		});
		expect(get(controller.state)).toMatchObject({
			open: true,
			status: TOKEN_PREVIEW_STATUS.Error,
			errorMessage: 'Unable to load preview'
		});

		await controller.retryTokenPreview();

		expect(getTokenPreviewMock).toHaveBeenCalledTimes(2);
		expect(get(controller.state)).toMatchObject({
			open: true,
			status: TOKEN_PREVIEW_STATUS.Ready,
			errorMessage: null
		});
	});

	it('keeps a failed source target selected and retries that exact source', async () => {
		getTokenPreviewMock
			.mockResolvedValueOnce(tokenResponse({ media: snapshotMedia() }))
			.mockRejectedValueOnce(new Error('rpc unavailable'))
			.mockResolvedValueOnce(tokenResponse({ media: liveMedia() }));
		const controller = createTokenPreviewController();
		await openSnapshot(controller);

		await controller.setTokenPreviewMediaMode(TEST_MEDIA.Source.Live);

		expect(get(controller.state)).toMatchObject({
			status: TOKEN_PREVIEW_STATUS.Error,
			selectedMediaMode: TEST_MEDIA.Source.Live,
			selectedMediaVariant: null,
			availableMediaVariants: []
		});
		expect(tokenPreviewQuery(1).get(COLLECTION_MEDIA_QUERY_PARAMS.MediaMode)).toBe(
			TEST_MEDIA.Source.Live
		);

		await controller.retryTokenPreview();

		expect(tokenPreviewQuery(2).get(COLLECTION_MEDIA_QUERY_PARAMS.MediaMode)).toBe(
			TEST_MEDIA.Source.Live
		);
		expect(tokenPreviewQuery(2).get(COLLECTION_MEDIA_QUERY_PARAMS.MediaVariant)).toBeNull();
		expect(get(controller.state)).toMatchObject({
			status: TOKEN_PREVIEW_STATUS.Ready,
			selectedMediaMode: TEST_MEDIA.Source.Live,
			selectedMediaVariant: TEST_MEDIA.Variant.Modern
		});
	});

	it('keeps a failed version target selected and retries that exact version', async () => {
		getTokenPreviewMock
			.mockResolvedValueOnce(tokenResponse({ media: snapshotMedia() }))
			.mockRejectedValueOnce(new Error('rpc unavailable'))
			.mockResolvedValueOnce(
				tokenResponse({
					media: snapshotMedia({
						selectedVariant: TEST_MEDIA.Variant.ModernAlternate
					})
				})
			);
		const controller = createTokenPreviewController();
		await openSnapshot(controller);

		await controller.setTokenPreviewMediaVariant(TEST_MEDIA.Variant.ModernAlternate);

		expect(get(controller.state)).toMatchObject({
			status: TOKEN_PREVIEW_STATUS.Error,
			selectedMediaMode: COLLECTION_MEDIA_MODES.Snapshot,
			selectedMediaVariant: TEST_MEDIA.Variant.ModernAlternate,
			availableMediaVariants: SNAPSHOT_VARIANTS
		});
		expect(tokenPreviewQuery(1).get(COLLECTION_MEDIA_QUERY_PARAMS.MediaVariant)).toBe(
			TEST_MEDIA.Variant.ModernAlternate
		);

		await controller.retryTokenPreview();

		expect(tokenPreviewQuery(2).get(COLLECTION_MEDIA_QUERY_PARAMS.MediaVariant)).toBe(
			TEST_MEDIA.Variant.ModernAlternate
		);
		expect(get(controller.state)).toMatchObject({
			status: TOKEN_PREVIEW_STATUS.Ready,
			selectedMediaVariant: TEST_MEDIA.Variant.ModernAlternate
		});
	});

	it('keeps activity event preview modes flat and cycles them with V', async () => {
		const eventModes = [
			{ key: TEST_MEDIA.EventMode.Captured, label: 'captured' },
			{ key: TEST_MEDIA.EventMode.Network, label: 'network' }
		];
		getActivityEventPreviewMock
			.mockResolvedValueOnce(activityResponse(TEST_MEDIA.EventMode.Captured, eventModes))
			.mockResolvedValueOnce(activityResponse(TEST_MEDIA.EventMode.Network, eventModes));
		const controller = createTokenPreviewController();

		await controller.openTokenPreview({
			chainRef: 'ethereum',
			collectionRef: 'terraforms',
			tokenId: '7710',
			selectedMediaMode: TEST_MEDIA.EventMode.Captured,
			availableMediaModes: eventModes,
			previewContext: {
				kind: TOKEN_PREVIEW_CONTEXT_KIND.ActivityEvent,
				activityId: 42
			}
		});
		controller.onWindowKeydown(keyboardEvent('v'));
		await flush();

		const query = getActivityEventPreviewMock.mock.calls[1]?.[4] as URLSearchParams;
		expect(query.get(ACTIVITY_EVENT_PREVIEW_QUERY_PARAMS.RenderMode)).toBe(
			TEST_MEDIA.EventMode.Network
		);
		expect(get(controller.state).availableMediaVariants).toEqual([]);
		expect(getTokenPreviewMock).not.toHaveBeenCalled();
	});

	it('uses the trigger image aspect ratio in the preview style contract', async () => {
		getTokenPreviewMock.mockResolvedValueOnce(tokenResponse({ media: snapshotMedia() }));
		const controller = createTokenPreviewController();
		await controller.openTokenPreview({
			chainRef: 'ethereum',
			collectionRef: 'terraforms',
			tokenId: '1',
			selectedMediaMode: COLLECTION_MEDIA_MODES.Snapshot,
			availableMediaModes: SOURCE_OPTIONS,
			previewAspectRatio: 0.6933333333333334
		});

		const state = get(controller.state);
		expect(state.aspectRatio).toBe(0.6933333333333334);
		expect(tokenPreviewStyle(state)).toContain('--token-preview-ar:0.6933333333333334;');
	});
});

function snapshotMedia(overrides: Partial<ApiTokenMediaState> = {}): ApiTokenMediaState {
	return {
		selectedMode: COLLECTION_MEDIA_MODES.Snapshot,
		defaultMode: COLLECTION_MEDIA_MODES.Snapshot,
		availableModes: SOURCE_OPTIONS,
		preference: ENABLED_V2_PREFERENCE,
		selectedVariant: TEST_MEDIA.Variant.ModernArtifact,
		defaultVariant: TEST_MEDIA.Variant.ModernArtifact,
		availableVariants: SNAPSHOT_VARIANTS,
		...overrides
	};
}

function liveMedia(): ApiTokenMediaState {
	return {
		selectedMode: TEST_MEDIA.Source.Live,
		defaultMode: COLLECTION_MEDIA_MODES.Snapshot,
		availableModes: SOURCE_OPTIONS,
		preference: ENABLED_V2_PREFERENCE,
		selectedVariant: TEST_MEDIA.Variant.Modern,
		defaultVariant: TEST_MEDIA.Variant.Modern,
		availableVariants: LIVE_VARIANTS
	};
}

function tokenResponse(input: {
	media: ApiTokenMediaState;
	tokenId?: string;
	image?: string | null;
	animationUrl?: string | null;
}): TokenPreviewApiResponse {
	return {
		token: {
			tokenId: input.tokenId ?? '1',
			image: input.image ?? null,
			animationUrl:
				input.animationUrl === undefined ? 'https://example.com/1.html' : input.animationUrl
		},
		media: input.media
	};
}

function activityResponse(
	selectedMode: string,
	availableModes: Array<{ key: string; label: string }>
) {
	return {
		token: {
			tokenId: '7710',
			image: null,
			animationUrl: 'data:text/html;base64,ZXZlbnQ='
		},
		media: {
			selectedMode,
			defaultMode: TEST_MEDIA.EventMode.Captured,
			availableModes,
			preference: null
		}
	};
}

async function openSnapshot(
	controller: ReturnType<typeof createTokenPreviewController>
): Promise<void> {
	await controller.openTokenPreview({
		chainRef: 'ethereum',
		collectionRef: 'terraforms',
		tokenId: '1',
		selectedMediaMode: COLLECTION_MEDIA_MODES.Snapshot,
		availableMediaModes: SOURCE_OPTIONS,
		mediaPreference: ENABLED_V2_PREFERENCE
	});
}

function tokenPreviewQuery(callIndex: number): URLSearchParams {
	return getTokenPreviewMock.mock.calls[callIndex]?.[4] as URLSearchParams;
}

function keyboardEvent(key: string): KeyboardEvent {
	return {
		key,
		defaultPrevented: false,
		metaKey: false,
		ctrlKey: false,
		altKey: false,
		preventDefault: vi.fn()
	} as unknown as KeyboardEvent;
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function adjacentPair(step: -1 | 1, tokenId: string): string | null {
	if (tokenId === '1' && step === 1) return '2';
	if (tokenId === '2' && step === -1) return '1';
	return null;
}

function createDeferred<T>(): {
	promise: Promise<T>;
	resolve(value: T): void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}
