import { browser } from '$app/environment';
import { get, writable, type Readable } from 'svelte/store';
import type { ApiCollectionMediaMode } from '$lib/api-types';
import { getTokenDetail } from '$lib/backend-api';
import { appendMediaModeParam, mediaModeLabel, nextMediaMode } from '$lib/media-mode';

const TOKEN_PREVIEW_HEIGHT_STORAGE_KEY = 'artgod.tokenBrowser.previewHeightPercent';
const DEFAULT_TOKEN_PREVIEW_HEIGHT_PERCENT = 90;
const MIN_TOKEN_PREVIEW_HEIGHT_PERCENT = 5;
const MAX_TOKEN_PREVIEW_HEIGHT_PERCENT = 100;
const TOKEN_PREVIEW_HEIGHT_STEP_PERCENT = 5;

export type TokenPreviewState = {
	open: boolean;
	mediaKind: 'iframe' | 'image' | null;
	mediaUrl: string | null;
	tokenId: string | null;
	chainRef: string | null;
	collectionRef: string | null;
	selectedMediaMode: string;
	availableMediaModes: ApiCollectionMediaMode[];
	heightPercent: number;
};

export type TokenPreviewController = {
	state: Readable<TokenPreviewState>;
	openTokenPreview(params: {
		chainRef: string;
		collectionRef: string;
		tokenId: string;
		selectedMediaMode: string;
		availableMediaModes: ApiCollectionMediaMode[];
	}): Promise<void>;
	cycleTokenPreviewMediaMode(): Promise<void>;
	closeTokenPreview(): void;
	onWindowKeydown(event: KeyboardEvent): void;
	tokenPreviewAriaLabel(tokenId: string): string;
	tokenPreviewMediaModeLabel(state: TokenPreviewState): string | null;
};

export function createTokenPreviewController(
	fetchFn: typeof fetch
): TokenPreviewController {
	const state = writable<TokenPreviewState>({
		open: false,
		mediaKind: null,
		mediaUrl: null,
		tokenId: null,
		chainRef: null,
		collectionRef: null,
		selectedMediaMode: 'truth',
		availableMediaModes: [],
		heightPercent: readInitialTokenPreviewHeightPercent()
	});
	let requestId = 0;

	async function openTokenPreview(params: {
		chainRef: string;
		collectionRef: string;
		tokenId: string;
		selectedMediaMode: string;
		availableMediaModes: ApiCollectionMediaMode[];
	}): Promise<void> {
		const chainRef = params.chainRef.trim();
		const collectionRef = params.collectionRef.trim();
		const tokenId = params.tokenId.trim();
		if (!chainRef || !collectionRef || !tokenId) return;

		const activeRequestId = ++requestId;
		state.update((current) => ({
			...current,
			open: true,
			mediaKind: null,
			mediaUrl: null,
			tokenId,
			chainRef,
			collectionRef,
			selectedMediaMode: params.selectedMediaMode,
			availableMediaModes: params.availableMediaModes
		}));

		try {
			const response = await getTokenDetail(
				fetchFn,
				chainRef,
				collectionRef,
				tokenId,
				buildMediaModeQuery(params.selectedMediaMode)
			);
			if (activeRequestId !== requestId) return;

			state.update((current) => ({
				...current,
				selectedMediaMode: response.media.selectedMode,
				availableMediaModes: response.media.availableModes
			}));

			if (response.token.animationUrl) {
				state.update((current) => ({
					...current,
					tokenId: response.token.tokenId,
					mediaKind: 'iframe',
					mediaUrl: response.token.animationUrl
				}));
				return;
			}

			if (response.token.image) {
				state.update((current) => ({
					...current,
					tokenId: response.token.tokenId,
					mediaKind: 'image',
					mediaUrl: response.token.image
				}));
				return;
			}

			closeTokenPreview();
		} catch {
			if (activeRequestId !== requestId) return;
			closeTokenPreview();
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
			availableMediaModes: current.availableMediaModes
		});
	}

	function closeTokenPreview(): void {
		requestId += 1;
		state.update((current) => ({
			...current,
			open: false,
			mediaKind: null,
			mediaUrl: null,
			tokenId: null,
			chainRef: null,
			collectionRef: null,
			selectedMediaMode: 'truth',
			availableMediaModes: []
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

		if (event.key === '+' || event.key === '=' || event.key === 'NumpadAdd') {
			event.preventDefault();
			updateHeightPercent(TOKEN_PREVIEW_HEIGHT_STEP_PERCENT);
			return;
		}

		if (event.key === '-' || event.key === '_' || event.key === 'NumpadSubtract') {
			event.preventDefault();
			updateHeightPercent(-TOKEN_PREVIEW_HEIGHT_STEP_PERCENT);
			return;
		}

		if (event.key === '0' || event.key === 'Numpad0') {
			event.preventDefault();
			setHeightPercent(DEFAULT_TOKEN_PREVIEW_HEIGHT_PERCENT);
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

	function updateHeightPercent(delta: number): void {
		const next = clampTokenPreviewHeightPercent(get(state).heightPercent + delta);
		setHeightPercent(next);
	}

	function setHeightPercent(value: number): void {
		const next = clampTokenPreviewHeightPercent(value);
		persistHeightPercent(next);
		state.update((current) => ({
			...current,
			heightPercent: next
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

export function tokenPreviewStyle(state: TokenPreviewState): string {
	return `--token-preview-height-vh:${state.heightPercent}vh;`;
}

function readInitialTokenPreviewHeightPercent(): number {
	if (!browser) return DEFAULT_TOKEN_PREVIEW_HEIGHT_PERCENT;
	try {
		const raw = window.localStorage.getItem(TOKEN_PREVIEW_HEIGHT_STORAGE_KEY);
		if (!raw) return DEFAULT_TOKEN_PREVIEW_HEIGHT_PERCENT;
		const parsed = Number(raw);
		if (!Number.isInteger(parsed)) return DEFAULT_TOKEN_PREVIEW_HEIGHT_PERCENT;
		return clampTokenPreviewHeightPercent(parsed);
	} catch {
		return DEFAULT_TOKEN_PREVIEW_HEIGHT_PERCENT;
	}
}

function clampTokenPreviewHeightPercent(value: number): number {
	return Math.min(MAX_TOKEN_PREVIEW_HEIGHT_PERCENT, Math.max(MIN_TOKEN_PREVIEW_HEIGHT_PERCENT, value));
}

function persistHeightPercent(value: number): void {
	if (!browser) return;
	try {
		window.localStorage.setItem(TOKEN_PREVIEW_HEIGHT_STORAGE_KEY, String(value));
	} catch {
		// Ignore storage failures and keep the in-memory state.
	}
}

function buildMediaModeQuery(mediaMode: string): URLSearchParams {
	const params = new URLSearchParams();
	appendMediaModeParam(params, mediaMode);
	return params;
}
