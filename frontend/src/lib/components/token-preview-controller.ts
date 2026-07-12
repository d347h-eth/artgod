import { browser } from '$app/environment';
import { COLLECTION_MEDIA_MODES } from '@artgod/shared/extensions';
import { ACTIVITY_EVENT_PREVIEW_QUERY_PARAMS } from '@artgod/shared/types';
import { getContext, setContext } from 'svelte';
import { get, writable, type Readable } from 'svelte/store';
import type {
	ActivityEventPreviewApiResponse,
	ApiCollectionMediaMode,
	ApiCollectionMediaPreference,
	ApiTokenMediaVariantOption,
	ApiTokenMediaState,
	TokenPreviewApiResponse
} from '$lib/api-types';
import { getActivityEventPreview, getTokenPreview } from '$lib/backend-api';
import { buildTokenMediaQuery, nextMediaOption, nextMediaMode } from '$lib/media-mode';
import {
	resolveTokenMediaAspectRatio,
	resolveTokenMediaIframeSource,
	tokenMediaTitle,
	type TokenMediaIframeSource
} from '$lib/token-media';
import { LOCAL_STORAGE_KEYS } from '$lib/local-storage-keys';

const DEFAULT_TOKEN_PREVIEW_SCALE_PERCENT = 100;
const MIN_TOKEN_PREVIEW_SCALE_PERCENT = 5;
const MAX_TOKEN_PREVIEW_SCALE_PERCENT = 100;
const TOKEN_PREVIEW_SCALE_STEP_PERCENT = 5;
const TOKEN_PREVIEW_CONTEXT_KEY = Symbol('token-preview-controller');
const TOKEN_PREVIEW_CACHE_CONTEXT_KIND = {
	Token: 'token'
} as const;
// Cache-key segments distinguish preference and default-version requests without leaking raw booleans.
const TOKEN_PREVIEW_CACHE_KEY_PART = {
	PreferenceDisabled: 'preference:disabled',
	PreferenceEnabled: 'preference:enabled',
	DefaultVariant: 'variant:default'
} as const;
export const TOKEN_PREVIEW_CONTEXT_KIND = {
	ActivityEvent: 'activity-event'
} as const;
// Preview lifecycle values shared by the controller, overlay, and focused tests.
export const TOKEN_PREVIEW_STATUS = {
	Closed: 'closed',
	Loading: 'loading',
	Ready: 'ready',
	Error: 'error'
} as const;
let fallbackTokenPreviewController: TokenPreviewController | null = null;

// Preview lifecycle status protects the overlay from ad hoc state strings.
export type TokenPreviewStatus = (typeof TOKEN_PREVIEW_STATUS)[keyof typeof TOKEN_PREVIEW_STATUS];

type TokenPreviewRequest = {
	chainRef: string;
	collectionRef: string;
	tokenId: string;
	mediaMode: string;
	mediaPreference: ApiCollectionMediaPreference | null;
	mediaVariant: string | null;
	previewContext: TokenPreviewContext | null;
};

export type TokenPreviewContext = {
	kind: typeof TOKEN_PREVIEW_CONTEXT_KIND.ActivityEvent;
	activityId: number;
};

type CachedTokenPreview = {
	response: TokenPreviewApiResponse | ActivityEventPreviewApiResponse;
	iframeSource: TokenPreviewIframeSource;
};

export type TokenPreviewAdjacentResolver = (step: -1 | 1, currentTokenId: string) => string | null;

export type TokenPreviewIframeSource = TokenMediaIframeSource;

export type TokenPreviewState = {
	open: boolean;
	status: TokenPreviewStatus;
	iframeSource: TokenPreviewIframeSource | null;
	tokenId: string | null;
	chainRef: string | null;
	collectionRef: string | null;
	selectedMediaMode: string;
	availableMediaModes: ApiCollectionMediaMode[];
	mediaPreference: ApiCollectionMediaPreference | null;
	selectedMediaVariant: string | null;
	defaultMediaVariant: string | null;
	availableMediaVariants: ApiTokenMediaVariantOption[];
	requestedMediaVariant: string | null;
	previewContext: TokenPreviewContext | null;
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
		mediaPreference?: ApiCollectionMediaPreference | null;
		previewContext?: TokenPreviewContext | null;
		previewAspectRatio?: number | null;
		adjacentTokenResolver?: TokenPreviewAdjacentResolver | null;
	}): Promise<void>;
	setTokenPreviewMediaMode(nextMode: string): Promise<void>;
	setTokenPreviewMediaVariant(nextVariant: string): Promise<void>;
	cycleTokenPreviewMediaMode(): Promise<void>;
	cycleTokenPreviewMediaVariant(): Promise<void>;
	retryTokenPreview(): Promise<void>;
	navigatePreviousTokenPreview(): Promise<void>;
	navigateNextTokenPreview(): Promise<void>;
	closeTokenPreview(): void;
	onWindowKeydown(event: KeyboardEvent): void;
	tokenPreviewAriaLabel(tokenId: string): string;
};

export function createTokenPreviewController(): TokenPreviewController {
	const state = writable<TokenPreviewState>({
		open: false,
		status: TOKEN_PREVIEW_STATUS.Closed,
		iframeSource: null,
		tokenId: null,
		chainRef: null,
		collectionRef: null,
		selectedMediaMode: COLLECTION_MEDIA_MODES.Snapshot,
		availableMediaModes: [],
		mediaPreference: null,
		selectedMediaVariant: null,
		defaultMediaVariant: null,
		availableMediaVariants: [],
		requestedMediaVariant: null,
		previewContext: null,
		scalePercent: readInitialTokenPreviewScalePercent(),
		aspectRatio: null,
		errorMessage: null,
		canNavigatePrevious: false,
		canNavigateNext: false
	});
	let requestId = 0;
	let adjacentTokenResolver: TokenPreviewAdjacentResolver | null = null;
	let lastFailedRequest: TokenPreviewRequest | null = null;
	const previewCache = new Map<string, CachedTokenPreview>();
	const previewRequestsInFlight = new Map<string, Promise<CachedTokenPreview | null>>();

	async function openTokenPreview(params: {
		chainRef: string;
		collectionRef: string;
		tokenId: string;
		selectedMediaMode: string;
		availableMediaModes: ApiCollectionMediaMode[];
		mediaPreference?: ApiCollectionMediaPreference | null;
		previewContext?: TokenPreviewContext | null;
		previewAspectRatio?: number | null;
		adjacentTokenResolver?: TokenPreviewAdjacentResolver | null;
		mediaVariant?: string | null;
		bypassCache?: boolean;
	}): Promise<void> {
		const chainRef = params.chainRef.trim();
		const collectionRef = params.collectionRef.trim();
		const tokenId = params.tokenId.trim();
		if (!chainRef || !collectionRef || !tokenId) return;

		adjacentTokenResolver = params.adjacentTokenResolver ?? null;
		const previewContext = params.previewContext ?? null;
		const mediaPreference = previewContext ? null : (params.mediaPreference ?? null);
		const mediaVariant = previewContext ? null : (params.mediaVariant ?? null);
		const request: TokenPreviewRequest = {
			chainRef,
			collectionRef,
			tokenId,
			mediaMode: params.selectedMediaMode,
			mediaPreference,
			mediaVariant,
			previewContext
		};
		const activeRequestId = ++requestId;
		lastFailedRequest = null;
		state.update((current) => {
			const keepDisplayedMedia =
				current.iframeSource !== null && current.status !== TOKEN_PREVIEW_STATUS.Error;
			const retainsKnownSourceOptions =
				!previewContext && current.selectedMediaMode === params.selectedMediaMode;
			const adjacentAvailability = resolveAdjacentAvailability(tokenId);
			return {
				...current,
				open: true,
				status: TOKEN_PREVIEW_STATUS.Loading,
				tokenId: keepDisplayedMedia ? current.tokenId : tokenId,
				chainRef,
				collectionRef,
				selectedMediaMode: params.selectedMediaMode,
				availableMediaModes: params.availableMediaModes,
				mediaPreference,
				selectedMediaVariant: previewContext
					? null
					: (mediaVariant ?? (retainsKnownSourceOptions ? current.selectedMediaVariant : null)),
				defaultMediaVariant: retainsKnownSourceOptions ? current.defaultMediaVariant : null,
				availableMediaVariants: retainsKnownSourceOptions ? current.availableMediaVariants : [],
				requestedMediaVariant: mediaVariant,
				previewContext,
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
			const preview = await loadTokenPreview(request, params.bypassCache ?? false);
			if (activeRequestId !== requestId) return;
			if (!preview) {
				lastFailedRequest = request;
				setPreviewError('No preview media available');
				return;
			}
			const tokenMedia = previewContext ? null : (preview.response.media as ApiTokenMediaState);

			state.update((current) => ({
				...current,
				open: true,
				status: TOKEN_PREVIEW_STATUS.Ready,
				iframeSource: preview.iframeSource,
				tokenId: preview.response.token.tokenId,
				selectedMediaMode: preview.response.media.selectedMode,
				availableMediaModes: preview.response.media.availableModes,
				mediaPreference: tokenMedia?.preference ?? null,
				selectedMediaVariant: tokenMedia?.selectedVariant ?? null,
				defaultMediaVariant: tokenMedia?.defaultVariant ?? null,
				availableMediaVariants: tokenMedia?.availableVariants ?? [],
				requestedMediaVariant: mediaVariant,
				previewContext,
				...resolveAdjacentAvailability(preview.response.token.tokenId),
				errorMessage: null
			}));
			prefetchAdjacentNeighbors({
				...request,
				tokenId: preview.response.token.tokenId,
				mediaMode: preview.response.media.selectedMode,
				mediaPreference: tokenMedia?.preference ?? mediaPreference
			});
		} catch {
			if (activeRequestId !== requestId) return;
			lastFailedRequest = request;
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

	async function cycleTokenPreviewMediaVariant(): Promise<void> {
		const current = get(state);
		if (
			!current.open ||
			current.previewContext ||
			current.availableMediaVariants.length <= 1 ||
			!current.selectedMediaVariant
		) {
			return;
		}
		const nextVariant = nextMediaOption(
			current.availableMediaVariants,
			current.selectedMediaVariant
		);
		await setTokenPreviewMediaVariant(nextVariant);
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
			mediaPreference: current.mediaPreference,
			mediaVariant: null,
			previewContext: current.previewContext,
			previewAspectRatio: current.aspectRatio,
			adjacentTokenResolver
		});
	}

	async function setTokenPreviewMediaVariant(nextVariant: string): Promise<void> {
		const current = get(state);
		if (
			!current.open ||
			current.previewContext ||
			!current.chainRef ||
			!current.collectionRef ||
			!current.tokenId ||
			current.availableMediaVariants.length <= 1 ||
			nextVariant === current.selectedMediaVariant ||
			!current.availableMediaVariants.some((variant) => variant.key === nextVariant)
		) {
			return;
		}
		await openTokenPreview({
			chainRef: current.chainRef,
			collectionRef: current.collectionRef,
			tokenId: current.tokenId,
			selectedMediaMode: current.selectedMediaMode,
			availableMediaModes: current.availableMediaModes,
			mediaPreference: current.mediaPreference,
			mediaVariant: nextVariant,
			previewContext: null,
			previewAspectRatio: current.aspectRatio,
			adjacentTokenResolver
		});
	}

	async function retryTokenPreview(): Promise<void> {
		const current = get(state);
		const request = lastFailedRequest;
		if (!current.open || !request) return;
		await openTokenPreview({
			chainRef: request.chainRef,
			collectionRef: request.collectionRef,
			tokenId: request.tokenId,
			selectedMediaMode: request.mediaMode,
			availableMediaModes: current.availableMediaModes,
			mediaPreference: request.mediaPreference,
			mediaVariant: request.mediaVariant,
			previewContext: request.previewContext,
			previewAspectRatio: current.aspectRatio,
			adjacentTokenResolver,
			bypassCache: true
		});
	}

	function closeTokenPreview(): void {
		requestId += 1;
		adjacentTokenResolver = null;
		lastFailedRequest = null;
		state.update((current) => ({
			...current,
			open: false,
			status: TOKEN_PREVIEW_STATUS.Closed,
			iframeSource: null,
			tokenId: null,
			chainRef: null,
			collectionRef: null,
			selectedMediaMode: COLLECTION_MEDIA_MODES.Snapshot,
			availableMediaModes: [],
			mediaPreference: null,
			selectedMediaVariant: null,
			defaultMediaVariant: null,
			availableMediaVariants: [],
			requestedMediaVariant: null,
			previewContext: null,
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
			if (current.previewContext) {
				void cycleTokenPreviewMediaMode();
			} else {
				void cycleTokenPreviewMediaVariant();
			}
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
			status: TOKEN_PREVIEW_STATUS.Error,
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
			mediaPreference: current.mediaPreference,
			mediaVariant: current.requestedMediaVariant,
			previewContext: current.previewContext,
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
		setTokenPreviewMediaVariant,
		cycleTokenPreviewMediaMode,
		cycleTokenPreviewMediaVariant,
		retryTokenPreview,
		navigatePreviousTokenPreview,
		navigateNextTokenPreview,
		closeTokenPreview,
		onWindowKeydown,
		tokenPreviewAriaLabel
	};

	async function loadTokenPreview(
		request: TokenPreviewRequest,
		bypassCache = false
	): Promise<CachedTokenPreview | null> {
		if (bypassCache || !isPreviewCacheable(request)) {
			return fetchTokenPreview(request);
		}
		const cacheKey = buildTokenPreviewCacheKey(request);
		const cached = previewCache.get(cacheKey);
		if (cached) {
			return cached;
		}

		const inFlight = previewRequestsInFlight.get(cacheKey);
		if (inFlight) {
			return inFlight;
		}

		const promise = fetchTokenPreview(request)
			.then((preview) => {
				if (preview) previewCache.set(cacheKey, preview);
				return preview;
			})
			.finally(() => {
				previewRequestsInFlight.delete(cacheKey);
			});

		previewRequestsInFlight.set(cacheKey, promise);
		return promise;
	}

	function prefetchAdjacentNeighbors(request: TokenPreviewRequest): void {
		if (!adjacentTokenResolver || !isPreviewCacheable(request)) {
			return;
		}
		for (const step of [-1, 1] as const) {
			const adjacentTokenId = adjacentTokenResolver(step, request.tokenId);
			if (!adjacentTokenId) {
				continue;
			}
			void loadTokenPreview({
				...request,
				tokenId: adjacentTokenId
			}).catch(() => undefined);
		}
	}
}

async function fetchTokenPreview(request: TokenPreviewRequest): Promise<CachedTokenPreview | null> {
	const response = await loadPreviewResponse(request);
	const iframeSource = resolveTokenMediaIframeSource(
		response.token.animationUrl,
		response.token.image,
		tokenMediaTitle(response.token.tokenId)
	);
	return iframeSource ? { response, iframeSource } : null;
}

function isPreviewCacheable(request: TokenPreviewRequest): boolean {
	return Boolean(request.previewContext) || request.mediaMode === COLLECTION_MEDIA_MODES.Snapshot;
}

function loadPreviewResponse(
	request: TokenPreviewRequest
): Promise<TokenPreviewApiResponse | ActivityEventPreviewApiResponse> {
	if (request.previewContext?.kind === TOKEN_PREVIEW_CONTEXT_KIND.ActivityEvent) {
		return getActivityEventPreview(
			globalThis.fetch,
			request.chainRef,
			request.collectionRef,
			request.previewContext.activityId,
			buildRenderModeQuery(request.mediaMode)
		);
	}
	return getTokenPreview(
		globalThis.fetch,
		request.chainRef,
		request.collectionRef,
		request.tokenId,
		buildTokenMediaQuery({
			mediaMode: request.mediaMode,
			mediaPreference: request.mediaPreference,
			mediaVariant: request.mediaVariant
		})
	);
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
		const raw = window.localStorage.getItem(LOCAL_STORAGE_KEYS.tokenPreviewScalePercent);
		if (!raw) return DEFAULT_TOKEN_PREVIEW_SCALE_PERCENT;
		const parsed = Number(raw);
		if (!Number.isInteger(parsed)) return DEFAULT_TOKEN_PREVIEW_SCALE_PERCENT;
		return clampTokenPreviewScalePercent(parsed);
	} catch {
		return DEFAULT_TOKEN_PREVIEW_SCALE_PERCENT;
	}
}

function clampTokenPreviewScalePercent(value: number): number {
	return Math.min(
		MAX_TOKEN_PREVIEW_SCALE_PERCENT,
		Math.max(MIN_TOKEN_PREVIEW_SCALE_PERCENT, value)
	);
}

function persistScalePercent(value: number): void {
	if (!browser) return;
	try {
		window.localStorage.setItem(LOCAL_STORAGE_KEYS.tokenPreviewScalePercent, String(value));
	} catch {
		// Ignore storage failures and keep the in-memory state.
	}
}

function buildRenderModeQuery(renderMode: string): URLSearchParams {
	const params = new URLSearchParams();
	params.set(ACTIVITY_EVENT_PREVIEW_QUERY_PARAMS.RenderMode, renderMode);
	return params;
}

function buildTokenPreviewCacheKey(request: TokenPreviewRequest): string {
	return [
		request.chainRef.trim().toLowerCase(),
		request.collectionRef.trim().toLowerCase(),
		request.tokenId.trim(),
		request.mediaMode.trim().toLowerCase(),
		request.mediaPreference?.enabled === false
			? TOKEN_PREVIEW_CACHE_KEY_PART.PreferenceDisabled
			: TOKEN_PREVIEW_CACHE_KEY_PART.PreferenceEnabled,
		request.mediaVariant?.trim().toLowerCase() ?? TOKEN_PREVIEW_CACHE_KEY_PART.DefaultVariant,
		request.previewContext
			? `${request.previewContext.kind}:${request.previewContext.activityId}`
			: TOKEN_PREVIEW_CACHE_CONTEXT_KIND.Token
	].join('|');
}
