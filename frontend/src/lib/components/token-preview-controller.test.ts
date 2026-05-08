import { describe, expect, it, vi, beforeEach } from 'vitest';
import { COLLECTION_MEDIA_MODES } from '@artgod/shared/extensions';
import { ACTIVITY_EVENT_PREVIEW_QUERY_PARAMS } from '@artgod/shared/types';
import { get } from 'svelte/store';

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
	tokenPreviewStyle
} from './token-preview-controller';

describe('token-preview-controller', () => {
	beforeEach(() => {
		getActivityEventPreviewMock.mockReset();
		getTokenPreviewMock.mockReset();
	});

	it('wraps image-only previews in a sandboxed iframe document source', async () => {
		getTokenPreviewMock.mockResolvedValueOnce({
			token: {
				tokenId: '1',
				image: 'https://example.com/1.png',
				animationUrl: null
			},
			media: {
				selectedMode: 'artifact',
				defaultMode: 'artifact',
				availableModes: [
					{ key: 'artifact', label: 'artifact' },
					{ key: 'snapshot', label: 'snapshot' }
				]
			}
		});

		const controller = createTokenPreviewController();

		await controller.openTokenPreview({
			chainRef: 'ethereum',
			collectionRef: 'terraforms',
			tokenId: '1',
			selectedMediaMode: 'artifact',
			availableMediaModes: [
				{ key: 'artifact', label: 'artifact' },
				{ key: 'snapshot', label: 'snapshot' }
			]
		});

		const state = get(controller.state);
		expect(state.open).toBe(true);
		expect(state.status).toBe('ready');
		expect(state.iframeSource?.kind).toBe('srcdoc');
		expect(state.iframeSource?.value).toContain('<img src="https://example.com/1.png"');
		expect(state.canNavigatePrevious).toBe(false);
		expect(state.canNavigateNext).toBe(false);
	});

	it('keeps the modal open with an error state when preview loading fails', async () => {
		getTokenPreviewMock.mockRejectedValueOnce(new Error('boom'));

		const controller = createTokenPreviewController();

		await controller.openTokenPreview({
			chainRef: 'ethereum',
			collectionRef: 'terraforms',
			tokenId: '1',
			selectedMediaMode: 'artifact',
			availableMediaModes: [{ key: 'artifact', label: 'artifact' }]
		});

		const state = get(controller.state);
		expect(state.open).toBe(true);
		expect(state.status).toBe('error');
		expect(state.errorMessage).toBe('Unable to load preview');
		expect(state.canNavigatePrevious).toBe(false);
		expect(state.canNavigateNext).toBe(false);
	});

	it('supports adjacent token navigation and scale hotkeys while preview is open', async () => {
		getTokenPreviewMock
			.mockResolvedValueOnce({
				token: {
					tokenId: '1',
					image: null,
					animationUrl: 'https://example.com/1.html'
				},
				media: {
					selectedMode: 'artifact',
					defaultMode: 'artifact',
					availableModes: [{ key: 'artifact', label: 'artifact' }]
				}
			})
			.mockResolvedValueOnce({
				token: {
					tokenId: '2',
					image: null,
					animationUrl: 'https://example.com/2.html'
				},
				media: {
					selectedMode: 'artifact',
					defaultMode: 'artifact',
					availableModes: [{ key: 'artifact', label: 'artifact' }]
				}
			});

		const controller = createTokenPreviewController();

		await controller.openTokenPreview({
			chainRef: 'ethereum',
			collectionRef: 'terraforms',
			tokenId: '1',
			selectedMediaMode: 'artifact',
			availableMediaModes: [{ key: 'artifact', label: 'artifact' }],
			adjacentTokenResolver: (step, currentTokenId) =>
				step === 1 && currentTokenId === '1' ? '2' : null
		});
		await flush();
		expect(get(controller.state).canNavigatePrevious).toBe(false);
		expect(get(controller.state).canNavigateNext).toBe(true);

		const growEvent = keyboardEvent('=');
		controller.onWindowKeydown(growEvent);
		expect(growEvent.preventDefault).toHaveBeenCalledOnce();
		expect(get(controller.state).scalePercent).toBe(100);

		const nextEvent = keyboardEvent('d');
		controller.onWindowKeydown(nextEvent);
		await flush();

		expect(nextEvent.preventDefault).toHaveBeenCalledOnce();
		expect(getTokenPreviewMock).toHaveBeenCalledTimes(2);
		expect(get(controller.state).tokenId).toBe('2');
		expect(get(controller.state).canNavigatePrevious).toBe(false);
		expect(get(controller.state).canNavigateNext).toBe(false);
	});

	it('keeps the current media visible while the next preview request is still loading', async () => {
		const deferred = createDeferred<{
			token: {
				tokenId: string;
				image: string | null;
				animationUrl: string | null;
			};
			media: {
				selectedMode: string;
				defaultMode: string;
				availableModes: { key: string; label: string }[];
			};
		}>();

		getTokenPreviewMock
			.mockResolvedValueOnce({
				token: {
					tokenId: '1',
					image: null,
					animationUrl: 'https://example.com/1.html'
				},
				media: {
					selectedMode: 'artifact',
					defaultMode: 'artifact',
					availableModes: [
						{ key: 'artifact', label: 'artifact' },
						{ key: 'snapshot', label: 'snapshot' }
					]
				}
			})
			.mockImplementationOnce(() => deferred.promise);

		const controller = createTokenPreviewController();

		await controller.openTokenPreview({
			chainRef: 'ethereum',
			collectionRef: 'terraforms',
			tokenId: '1',
			selectedMediaMode: 'artifact',
			availableMediaModes: [
				{ key: 'artifact', label: 'artifact' },
				{ key: 'snapshot', label: 'snapshot' }
			]
		});

		const initialIframeSource = get(controller.state).iframeSource;
		void controller.cycleTokenPreviewMediaMode();
		await flush();
		const loadingState = get(controller.state);
		expect(loadingState.status).toBe('loading');
		expect(loadingState.iframeSource).toEqual(initialIframeSource);

		deferred.resolve({
			token: {
				tokenId: '1',
				image: null,
				animationUrl: 'https://example.com/1-snapshot.html'
			},
			media: {
				selectedMode: 'snapshot',
				defaultMode: 'artifact',
				availableModes: [
					{ key: 'artifact', label: 'artifact' },
					{ key: 'snapshot', label: 'snapshot' }
				]
			}
		});
		await flush();
		await flush();

		const finalState = get(controller.state);
		expect(finalState.status).toBe('ready');
		expect(finalState.selectedMediaMode).toBe('snapshot');
		expect(finalState.iframeSource?.kind).toBe('src');
		expect(finalState.iframeSource?.value).toBe('https://example.com/1-snapshot.html');
	});

	it('cycles through token-local media modes in the returned order', async () => {
		getTokenPreviewMock
			.mockResolvedValueOnce({
				token: {
					tokenId: '7710',
					image: null,
					animationUrl: 'https://example.com/7710-artifact.html'
				},
				media: {
					selectedMode: 'artifact',
					defaultMode: 'artifact',
					availableModes: [
						{ key: 'artifact', label: 'artifact' },
						{ key: 'lost-terrain', label: 'lost' },
						{ key: 'snapshot', label: 'snapshot' }
					]
				}
			})
			.mockResolvedValueOnce({
				token: {
					tokenId: '7710',
					image: null,
					animationUrl: 'https://example.com/7710-lost.html'
				},
				media: {
					selectedMode: 'lost-terrain',
					defaultMode: 'artifact',
					availableModes: [
						{ key: 'artifact', label: 'artifact' },
						{ key: 'lost-terrain', label: 'lost' },
						{ key: 'snapshot', label: 'snapshot' }
					]
				}
			});

		const controller = createTokenPreviewController();

		await controller.openTokenPreview({
			chainRef: 'ethereum',
			collectionRef: 'terraforms',
			tokenId: '7710',
			selectedMediaMode: 'artifact',
			availableMediaModes: [
				{ key: 'artifact', label: 'artifact' },
				{ key: 'snapshot', label: 'snapshot' }
			]
		});

		await controller.cycleTokenPreviewMediaMode();

		const state = get(controller.state);
		expect(state.selectedMediaMode).toBe('lost-terrain');
		expect(state.availableMediaModes).toEqual([
			{ key: 'artifact', label: 'artifact' },
			{ key: 'lost-terrain', label: 'lost' },
			{ key: 'snapshot', label: 'snapshot' }
		]);
		expect(state.iframeSource?.kind).toBe('src');
		expect(state.iframeSource?.value).toBe('https://example.com/7710-lost.html');
	});

	it('uses the trigger image aspect ratio in the preview style contract', async () => {
		getTokenPreviewMock.mockResolvedValueOnce({
			token: {
				tokenId: '1',
				image: null,
				animationUrl: 'https://example.com/1.html'
			},
			media: {
				selectedMode: 'artifact',
				defaultMode: 'artifact',
				availableModes: [{ key: 'artifact', label: 'artifact' }]
			}
		});

		const controller = createTokenPreviewController();

		await controller.openTokenPreview({
			chainRef: 'ethereum',
			collectionRef: 'terraforms',
			tokenId: '1',
			selectedMediaMode: 'artifact',
			availableMediaModes: [{ key: 'artifact', label: 'artifact' }],
			previewAspectRatio: 0.6933333333333334
		});

		const state = get(controller.state);
		expect(state.aspectRatio).toBe(0.6933333333333334);
		expect(tokenPreviewStyle(state)).toContain('--token-preview-ar:0.6933333333333334;');
	});

	it('loads activity event previews through the activity event preview endpoint', async () => {
		getActivityEventPreviewMock.mockResolvedValueOnce({
			token: {
				tokenId: '7710',
				image: null,
				animationUrl: 'data:text/html;base64,ZXZlbnQ='
			},
			media: {
				selectedMode: COLLECTION_MEDIA_MODES.Artifact,
				defaultMode: COLLECTION_MEDIA_MODES.Artifact,
				availableModes: [{ key: COLLECTION_MEDIA_MODES.Artifact, label: COLLECTION_MEDIA_MODES.Artifact }]
			}
		});

		const controller = createTokenPreviewController();

		await controller.openTokenPreview({
			chainRef: 'ethereum',
			collectionRef: 'terraforms',
			tokenId: '7710',
			selectedMediaMode: COLLECTION_MEDIA_MODES.Artifact,
			availableMediaModes: [
				{ key: COLLECTION_MEDIA_MODES.Artifact, label: COLLECTION_MEDIA_MODES.Artifact }
			],
			previewContext: {
				kind: TOKEN_PREVIEW_CONTEXT_KIND.ActivityEvent,
				activityId: 42
			}
		});

		const query = getActivityEventPreviewMock.mock.calls[0]?.[4] as URLSearchParams;
		expect(getActivityEventPreviewMock).toHaveBeenCalledWith(
			globalThis.fetch,
			'ethereum',
			'terraforms',
			42,
			expect.any(URLSearchParams)
		);
		expect(query.get(ACTIVITY_EVENT_PREVIEW_QUERY_PARAMS.RenderMode)).toBe(
			COLLECTION_MEDIA_MODES.Artifact
		);
		expect(getTokenPreviewMock).not.toHaveBeenCalled();
		expect(get(controller.state).iframeSource?.kind).toBe('src');
	});
});

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

function createDeferred<T>(): {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
} {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return {
		promise,
		resolve,
		reject
	};
}
