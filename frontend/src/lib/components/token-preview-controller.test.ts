import { describe, expect, it, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';

const { getTokenPreviewMock } = vi.hoisted(() => ({
	getTokenPreviewMock: vi.fn()
}));

vi.mock('$lib/backend-api', () => ({
	getTokenPreview: getTokenPreviewMock
}));

import { createTokenPreviewController, tokenPreviewStyle } from './token-preview-controller';

describe('token-preview-controller', () => {
	beforeEach(() => {
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

		const growEvent = keyboardEvent('=');
		controller.onWindowKeydown(growEvent);
		expect(growEvent.preventDefault).toHaveBeenCalledOnce();
		expect(get(controller.state).scalePercent).toBe(95);

		const nextEvent = keyboardEvent('d');
		controller.onWindowKeydown(nextEvent);
		await flush();

		expect(nextEvent.preventDefault).toHaveBeenCalledOnce();
		expect(getTokenPreviewMock).toHaveBeenCalledTimes(2);
		expect(get(controller.state).tokenId).toBe('2');
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
