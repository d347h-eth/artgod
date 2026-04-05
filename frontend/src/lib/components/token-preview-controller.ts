import { browser } from '$app/environment';
import { getContext, setContext } from 'svelte';
import { get, writable, type Readable } from 'svelte/store';
import type { ApiCollectionMediaMode, TokenPreviewApiResponse } from '$lib/api-types';
import { getTokenPreview } from '$lib/backend-api';
import { appendMediaModeParam, nextMediaMode } from '$lib/media-mode';
import {
	resolveTokenMediaAspectRatio,
	resolveTokenMediaIframeSource,
	tokenMediaTitle,
	type TokenMediaIframeSource
} from '$lib/token-media';
import { TOKEN_PREVIEW_SCALE_STORAGE_KEY } from '$lib/token-preview-storage';

const DEFAULT_TOKEN_PREVIEW_SCALE_PERCENT = 100;
const MIN_TOKEN_PREVIEW_SCALE_PERCENT = 5;
const MAX_TOKEN_PREVIEW_SCALE_PERCENT = 100;
const TOKEN_PREVIEW_SCALE_STEP_PERCENT = 5;
const TOKEN_PREVIEW_CONTEXT_KEY = Symbol('token-preview-controller');
let fallbackTokenPreviewController: TokenPreviewController | null = null;

type TokenPreviewRequest = {
	chainRef: string;
	collectionRef: string;
	tokenId: string;
	mediaMode: string;
};

type CachedTokenPreview = {
	response: TokenPreviewApiResponse;
	iframeSource: TokenPreviewIframeSource;
};

export type TokenPreviewAdjacentResolver = (
	step: -1 | 1,
	currentTokenId: string
) => string | null;

export type TokenPreviewIframeSource = TokenMediaIframeSource;

export type TokenPreviewState = {
	open: boolean;
	status: 'closed' | 'loading' | 'ready' | 'error';
	iframeSource: TokenPreviewIframeSource | null;
	tokenId: string | null;
	chainRef: string | null;
	collectionRef: string | null;
	selectedMediaMode: string;
	availableMediaModes: ApiCollectionMediaMode[];
	scalePercent: number;
	aspectRatio: number | null;
	errorMessage: string | null;
	canNavigatePrevious: boolean;
	canNavigateNext: boolean;
};

export type TokenPreviewController = {
	state: Readable<TokenPreviewState>;
	openTokenPreview(params: {
		chainRef: string;
		collectionRef: string;
		tokenId: string;
		selectedMediaMode: string;
		availableMediaModes: ApiCollectionMediaMode[];
		previewAspectRatio?: number | null;
		adjacentTokenResolver?: TokenPreviewAdjacentResolver | null;
	}): Promise<void>;
	setTokenPreviewMediaMode(nextMode: string): Promise<void>;
	cycleTokenPreviewMediaMode(): Promise<void>;
	navigatePreviousTokenPreview(): Promise<void>;
	navigateNextTokenPreview(): Promise<void>;
	closeTokenPreview(): void;
	onWindowKeydown(event: KeyboardEvent): void;
	tokenPreviewAriaLabel(tokenId: string): string;
};

export function createTokenPreviewController(): TokenPreviewController {
	const state = writable<TokenPreviewState>({
		open: false,
		status: 'closed',
		iframeSource: null,
		tokenId: null,
		chainRef: null,
		collectionRef: null,
		selectedMediaMode: 'snapshot',
		availableMediaModes: [],
		scalePercent: readInitialTokenPreviewScalePercent(),
		aspectRatio: null,
		errorMessage: null,
		canNavigatePrevious: false,
		canNavigateNext: false
	});
	let requestId = 0;
	let adjacentTokenResolver: TokenPreviewAdjacentResolver | null = null;
	const previewCache = new Map<string, CachedTokenPreview>();
	const previewRequestsInFlight = new Map<string, Promise<CachedTokenPreview | null>>();

	async function openTokenPreview(params: {
		chainRef: string;
		collectionRef: string;
		tokenId: string;
		selectedMediaMode: string;
		availableMediaModes: ApiCollectionMediaMode[];
		previewAspectRatio?: number | null;
		adjacentTokenResolver?: TokenPreviewAdjacentResolver | null;
	}): Promise<void> {
		const chainRef = params.chainRef.trim();
		const collectionRef = params.collectionRef.trim();
		const tokenId = params.tokenId.trim();
		if (!chainRef || !collectionRef || !tokenId) return;

		adjacentTokenResolver = params.adjacentTokenResolver ?? null;
		const activeRequestId = ++requestId;
		state.update((current) => {
			const keepDisplayedMedia = current.iframeSource !== null && current.status !== 'error';
			const adjacentAvailability = resolveAdjacentAvailability(tokenId);
			return {
				...current,
				open: true,
				status: 'loading',
				tokenId: keepDisplayedMedia ? current.tokenId : tokenId,
				chainRef,
				collectionRef,
				selectedMediaMode: keepDisplayedMedia
					? current.selectedMediaMode
					: params.selectedMediaMode,
				availableMediaModes: keepDisplayedMedia
					? current.availableMediaModes
					: params.availableMediaModes,
				aspectRatio: resolveTokenMediaAspectRatio(
					params.previewAspectRatio ?? null,
					current.aspectRatio
				),
				canNavigatePrevious: adjacentAvailability.canNavigatePrevious,
				canNavigateNext: adjacentAvailability.canNavigateNext,
				errorMessage: null
			};
		});

		try {
			const preview = await loadTokenPreview({
				chainRef,
				collectionRef,
				tokenId,
				mediaMode: params.selectedMediaMode
			});
			if (activeRequestId !== requestId) return;
			if (!preview) {
				setPreviewError('No preview media available');
				return;
			}

			state.update((current) => ({
				...current,
				open: true,
				status: 'ready',
				iframeSource: preview.iframeSource,
				tokenId: preview.response.token.tokenId,
				selectedMediaMode: preview.response.media.selectedMode,
				availableMediaModes: preview.response.media.availableModes,
				...resolveAdjacentAvailability(preview.response.token.tokenId),
				errorMessage: null
			}));
			prefetchAdjacentNeighbors({
				chainRef,
				collectionRef,
				tokenId: preview.response.token.tokenId,
				mediaMode: preview.response.media.selectedMode
			});
		} catch {
			if (activeRequestId !== requestId) return;
			setPreviewError('Unable to load preview');
		}
	}

	async function cycleTokenPreviewMediaMode(): Promise<void> {
		const current = get(state);
		if (!current.open || !current.chainRef || !current.collectionRef || !current.tokenId) {
			return;
		}
		if (current.availableMediaModes.length <= 1) {
			return;
		}
		const nextMode = nextMediaMode(current.availableMediaModes, current.selectedMediaMode);
		await setTokenPreviewMediaMode(nextMode);
	}

	async function setTokenPreviewMediaMode(nextMode: string): Promise<void> {
		const current = get(state);
		if (!current.open || !current.chainRef || !current.collectionRef || !current.tokenId) {
			return;
		}
		if (current.availableMediaModes.length <= 1) {
			return;
		}
		if (nextMode === current.selectedMediaMode) {
			return;
		}
		await openTokenPreview({
			chainRef: current.chainRef,
			collectionRef: current.collectionRef,
			tokenId: current.tokenId,
			selectedMediaMode: nextMode,
			availableMediaModes: current.availableMediaModes,
			previewAspectRatio: current.aspectRatio,
			adjacentTokenResolver
		});
	}

	function closeTokenPreview(): void {
		requestId += 1;
		adjacentTokenResolver = null;
		state.update((current) => ({
			...current,
			open: false,
			status: 'closed',
			iframeSource: null,
			tokenId: null,
			chainRef: null,
			collectionRef: null,
			selectedMediaMode: 'snapshot',
			availableMediaModes: [],
			aspectRatio: null,
			errorMessage: null,
			canNavigatePrevious: false,
			canNavigateNext: false
		}));
	}

	function onWindowKeydown(event: KeyboardEvent): void {
		const current = get(state);
		if (!current.open) return;
		if (event.defaultPrevented) return;
		if (event.metaKey || event.ctrlKey || event.altKey) return;

		if (event.key === 'Escape') {
			event.preventDefault();
			closeTokenPreview();
			return;
		}

		if (event.key === 'v' || event.key === 'V') {
			event.preventDefault();
			void cycleTokenPreviewMediaMode();
			return;
		}

		const navigationStep = previewNavigationStep(event);
		if (navigationStep !== 0) {
			event.preventDefault();
			void openAdjacentTokenPreview(navigationStep);
			return;
		}

		if (event.key === '+' || event.key === '=' || event.key === 'NumpadAdd') {
			event.preventDefault();
			updateScalePercent(TOKEN_PREVIEW_SCALE_STEP_PERCENT);
			return;
		}

		if (event.key === '-' || event.key === '_' || event.key === 'NumpadSubtract') {
			event.preventDefault();
			updateScalePercent(-TOKEN_PREVIEW_SCALE_STEP_PERCENT);
			return;
		}

		if (event.key === '0' || event.key === 'Numpad0') {
			event.preventDefault();
			setScalePercent(DEFAULT_TOKEN_PREVIEW_SCALE_PERCENT);
		}
	}

	function tokenPreviewAriaLabel(tokenId: string): string {
		return `preview token ${tokenId}`;
	}

	function setPreviewError(message: string): void {
		state.update((current) => ({
			...current,
			open: true,
			status: 'error',
			iframeSource: null,
			errorMessage: message
		}));
	}

	async function openAdjacentTokenPreview(step: -1 | 1): Promise<void> {
		const current = get(state);
		if (!current.open || !current.chainRef || !current.collectionRef || !current.tokenId) {
			return;
		}
		if (!adjacentTokenResolver) {
			return;
		}
		const nextTokenId = adjacentTokenResolver(step, current.tokenId);
		if (!nextTokenId) {
			return;
		}
		await openTokenPreview({
			chainRef: current.chainRef,
			collectionRef: current.collectionRef,
			tokenId: nextTokenId,
			selectedMediaMode: current.selectedMediaMode,
			availableMediaModes: current.availableMediaModes,
			previewAspectRatio: current.aspectRatio,
			adjacentTokenResolver
		});
	}

	async function navigatePreviousTokenPreview(): Promise<void> {
		await openAdjacentTokenPreview(-1);
	}

	async function navigateNextTokenPreview(): Promise<void> {
		await openAdjacentTokenPreview(1);
	}

	function updateScalePercent(delta: number): void {
		setScalePercent(get(state).scalePercent + delta);
	}

	function setScalePercent(value: number): void {
		const next = clampTokenPreviewScalePercent(value);
		persistScalePercent(next);
		state.update((current) => ({
			...current,
			scalePercent: next
		}));
	}

	function resolveAdjacentAvailability(tokenId: string | null): {
		canNavigatePrevious: boolean;
		canNavigateNext: boolean;
	} {
		if (!adjacentTokenResolver || !tokenId) {
			return {
				canNavigatePrevious: false,
				canNavigateNext: false
			};
		}

		return {
			canNavigatePrevious: adjacentTokenResolver(-1, tokenId) !== null,
			canNavigateNext: adjacentTokenResolver(1, tokenId) !== null
		};
	}

	return {
		state: { subscribe: state.subscribe },
		openTokenPreview,
		setTokenPreviewMediaMode,
		cycleTokenPreviewMediaMode,
		navigatePreviousTokenPreview,
		navigateNextTokenPreview,
		closeTokenPreview,
		onWindowKeydown,
		tokenPreviewAriaLabel
	};

	async function loadTokenPreview(
		request: TokenPreviewRequest
	): Promise<CachedTokenPreview | null> {
		const cacheKey = buildTokenPreviewCacheKey(request);
		const cached = previewCache.get(cacheKey);
		if (cached) {
			return cached;
		}

		const inFlight = previewRequestsInFlight.get(cacheKey);
		if (inFlight) {
			return inFlight;
		}

		const promise = getTokenPreview(
			globalThis.fetch,
			request.chainRef,
			request.collectionRef,
			request.tokenId,
			buildMediaModeQuery(request.mediaMode)
		)
				.then((response) => {
					const iframeSource = resolveTokenMediaIframeSource(
						response.token.animationUrl,
						response.token.image,
						tokenMediaTitle(response.token.tokenId)
					);
				if (!iframeSource) {
					return null;
				}
				const preview = {
					response,
					iframeSource
				};
				previewCache.set(cacheKey, preview);
				return preview;
			})
			.finally(() => {
				previewRequestsInFlight.delete(cacheKey);
			});

		previewRequestsInFlight.set(cacheKey, promise);
		return promise;
	}

	function prefetchAdjacentNeighbors(request: TokenPreviewRequest): void {
		if (!adjacentTokenResolver) {
			return;
		}
		for (const step of [-1, 1] as const) {
			const adjacentTokenId = adjacentTokenResolver(step, request.tokenId);
			if (!adjacentTokenId) {
				continue;
			}
			void loadTokenPreview({
				chainRef: request.chainRef,
				collectionRef: request.collectionRef,
				tokenId: adjacentTokenId,
				mediaMode: request.mediaMode
			}).catch(() => undefined);
		}
	}
}

export function setTokenPreviewControllerContext(
	controller: TokenPreviewController
): TokenPreviewController {
	setContext(TOKEN_PREVIEW_CONTEXT_KEY, controller);
	return controller;
}

export function getTokenPreviewController(): TokenPreviewController {
	const controller = getContext<TokenPreviewController | undefined>(TOKEN_PREVIEW_CONTEXT_KEY);
	if (controller) return controller;
	if (!fallbackTokenPreviewController) {
		fallbackTokenPreviewController = createTokenPreviewController();
	}
	return fallbackTokenPreviewController;
}

export function tokenPreviewStyle(state: TokenPreviewState): string {
	return `--token-preview-scale:${state.scalePercent / 100};--token-preview-ar:${resolveTokenMediaAspectRatio(
		state.aspectRatio,
		1
	)};`;
}

function previewNavigationStep(event: KeyboardEvent): -1 | 0 | 1 {
	if (event.key === 'a' || event.key === 'A' || event.key === 'ArrowLeft') {
		return -1;
	}
	if (event.key === 'd' || event.key === 'D' || event.key === 'ArrowRight') {
		return 1;
	}
	return 0;
}

function readInitialTokenPreviewScalePercent(): number {
	if (!browser) return DEFAULT_TOKEN_PREVIEW_SCALE_PERCENT;
	try {
		const raw = window.localStorage.getItem(TOKEN_PREVIEW_SCALE_STORAGE_KEY);
		if (!raw) return DEFAULT_TOKEN_PREVIEW_SCALE_PERCENT;
		const parsed = Number(raw);
		if (!Number.isInteger(parsed)) return DEFAULT_TOKEN_PREVIEW_SCALE_PERCENT;
		return clampTokenPreviewScalePercent(parsed);
	} catch {
		return DEFAULT_TOKEN_PREVIEW_SCALE_PERCENT;
	}
}

function clampTokenPreviewScalePercent(value: number): number {
	return Math.min(MAX_TOKEN_PREVIEW_SCALE_PERCENT, Math.max(MIN_TOKEN_PREVIEW_SCALE_PERCENT, value));
}

function persistScalePercent(value: number): void {
	if (!browser) return;
	try {
		window.localStorage.setItem(TOKEN_PREVIEW_SCALE_STORAGE_KEY, String(value));
	} catch {
		// Ignore storage failures and keep the in-memory state.
	}
}

function buildMediaModeQuery(mediaMode: string): URLSearchParams {
	const params = new URLSearchParams();
	appendMediaModeParam(params, mediaMode);
	return params;
}

function buildTokenPreviewCacheKey(request: TokenPreviewRequest): string {
	return [
		request.chainRef.trim().toLowerCase(),
		request.collectionRef.trim().toLowerCase(),
		request.tokenId.trim(),
		request.mediaMode.trim().toLowerCase()
	].join('|');
}
