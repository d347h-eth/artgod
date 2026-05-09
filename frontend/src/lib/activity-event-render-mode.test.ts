import { describe, expect, it } from 'vitest';
import { COLLECTION_MEDIA_MODES } from '@artgod/shared/extensions';
import { resolveActivityEventRenderMode } from './activity-event-render-mode';

const EXTENSION_FALLBACK_RENDER_MODE = 'extension-fallback-render-mode';
const EVENT_RENDER_MODE_OPTIONS = [
	{ key: COLLECTION_MEDIA_MODES.Artifact, label: COLLECTION_MEDIA_MODES.Artifact },
	{ key: EXTENSION_FALLBACK_RENDER_MODE, label: EXTENSION_FALLBACK_RENDER_MODE }
];
const EXTENSION_MEDIA_MODE = 'extension-media-mode';

describe('resolveActivityEventRenderMode', () => {
	it('keeps artifact media preference on artifact event rendering', () => {
		expect(
			resolveActivityEventRenderMode(
				COLLECTION_MEDIA_MODES.Artifact,
				EVENT_RENDER_MODE_OPTIONS
			)
		).toBe(COLLECTION_MEDIA_MODES.Artifact);
	});

	it('maps snapshot media preference to the extension fallback event rendering', () => {
		expect(
			resolveActivityEventRenderMode(
				COLLECTION_MEDIA_MODES.Snapshot,
				EVENT_RENDER_MODE_OPTIONS
			)
		).toBe(EXTENSION_FALLBACK_RENDER_MODE);
	});

	it('maps non-artifact media preferences to the extension fallback event rendering', () => {
		expect(
			resolveActivityEventRenderMode(
				EXTENSION_MEDIA_MODE,
				EVENT_RENDER_MODE_OPTIONS
			)
		).toBe(EXTENSION_FALLBACK_RENDER_MODE);
	});

	it('returns the media preference when no event render modes exist', () => {
		expect(resolveActivityEventRenderMode(COLLECTION_MEDIA_MODES.Snapshot, undefined)).toBe(
			COLLECTION_MEDIA_MODES.Snapshot
		);
	});
});
