import { browser } from '$app/environment';
import { getContext, setContext } from 'svelte';
import { get, writable, type Readable } from 'svelte/store';
import type { ApiCollectionMediaMode } from '$lib/api-types';
import { getTokenDetail } from '$lib/backend-api';
import { appendMediaModeParam, mediaModeLabel, nextMediaMode } from '$lib/media-mode';

const TOKEN_PREVIEW_SCALE_STORAGE_KEY = 'artgod.tokenBrowser.previewScalePercent';
const DEFAULT_TOKEN_PREVIEW_SCALE_PERCENT = 90;
const MIN_TOKEN_PREVIEW_SCALE_PERCENT = 5;
const MAX_TOKEN_PREVIEW_SCALE_PERCENT = 100;
const TOKEN_PREVIEW_SCALE_STEP_PERCENT = 5;
const TOKEN_PREVIEW_CONTEXT_KEY = Symbol('token-preview-controller');
let fallbackTokenPreviewController: TokenPreviewController | null = null;

export type TokenPreviewAdjacentResolver = (
	step: -1 | 1,
	currentTokenId: string
) => string | null;

export type TokenPreviewIframeSource =
	| {
			kind: 'src';
			value: string;
	  }
	| {
			kind: 'srcdoc';
			value: string;
	  };

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
	cycleTokenPreviewMediaMode(): Promise<void>;
	closeTokenPreview(): void;
	onWindowKeydown(event: KeyboardEvent): void;
	tokenPreviewAriaLabel(tokenId: string): string;
	tokenPreviewMediaModeLabel(state: TokenPreviewState): string | null;
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
		errorMessage: null
	});
	let requestId = 0;
	let adjacentTokenResolver: TokenPreviewAdjacentResolver | null = null;

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
		state.update((current) => ({
			...current,
			open: true,
			status: 'loading',
			iframeSource: null,
			tokenId,
			chainRef,
			collectionRef,
			selectedMediaMode: params.selectedMediaMode,
			availableMediaModes: params.availableMediaModes,
			aspectRatio: resolvePreviewAspectRatio(
				params.previewAspectRatio ?? null,
				current.aspectRatio
			),
			errorMessage: null
		}));

		try {
			const response = await getTokenDetail(
				globalThis.fetch,
				chainRef,
				collectionRef,
				tokenId,
				buildMediaModeQuery(params.selectedMediaMode)
			);
			if (activeRequestId !== requestId) return;

			const iframeSource = resolveTokenPreviewIframeSource(
				response.token.animationUrl,
				response.token.image,
				tokenPreviewTitle(response.token.tokenId)
			);
			if (!iframeSource) {
				setPreviewError('No preview media available');
				return;
			}

			state.update((current) => ({
				...current,
				open: true,
				status: 'ready',
				iframeSource,
				tokenId: response.token.tokenId,
				selectedMediaMode: response.media.selectedMode,
				availableMediaModes: response.media.availableModes,
				errorMessage: null
			}));
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
			errorMessage: null
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

	function tokenPreviewMediaModeLabel(state: TokenPreviewState): string | null {
		if (state.availableMediaModes.length <= 1) {
			return null;
		}
		return mediaModeLabel(state.availableMediaModes, state.selectedMediaMode);
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

	return {
		state: { subscribe: state.subscribe },
		openTokenPreview,
		cycleTokenPreviewMediaMode,
		closeTokenPreview,
		onWindowKeydown,
		tokenPreviewAriaLabel,
		tokenPreviewMediaModeLabel
	};
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
	return `--token-preview-scale:${state.scalePercent / 100};--token-preview-ar:${resolvePreviewAspectRatio(
		state.aspectRatio,
		1
	)};`;
}

function resolvePreviewAspectRatio(
	value: number | null | undefined,
	fallback: number | null
): number | null {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
		return value;
	}
	if (typeof fallback === 'number' && Number.isFinite(fallback) && fallback > 0) {
		return fallback;
	}
	return null;
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

function resolveTokenPreviewIframeSource(
	animationUrl: string | null,
	imageUrl: string | null,
	title: string
): TokenPreviewIframeSource | null {
	if (animationUrl) {
		return {
			kind: 'src',
			value: animationUrl
		};
	}
	if (imageUrl) {
		return {
			kind: 'srcdoc',
			value: buildImagePreviewDocument(imageUrl, title)
		};
	}
	return null;
}

function buildImagePreviewDocument(imageUrl: string, title: string): string {
	const escapedUrl = escapeHtml(imageUrl);
	const escapedTitle = escapeHtml(title);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapedTitle}</title>
<style>
	html, body {
		margin: 0;
		width: 100%;
		height: 100%;
		background: #111;
	}
	body {
		display: grid;
		place-items: center;
		overflow: hidden;
	}
	img {
		display: block;
		max-width: 100%;
		max-height: 100%;
		width: auto;
		height: auto;
		object-fit: contain;
	}
</style>
</head>
<body>
<img src="${escapedUrl}" alt="${escapedTitle}" referrerpolicy="no-referrer" />
</body>
</html>`;
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

function tokenPreviewTitle(tokenId: string): string {
	return `token ${tokenId}`;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}
