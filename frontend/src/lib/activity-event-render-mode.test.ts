import { describe, expect, it } from 'vitest';
import { COLLECTION_MEDIA_MODES } from '@artgod/shared/extensions';
import { resolveActivityEventRenderMode } from './activity-event-render-mode';

const TEST_EVENT_RENDER_MODES = {
	Preferred: 'preferred-event-render-mode',
	Fallback: 'extension-fallback-render-mode'
} as const;
const EVENT_RENDER_MODE_OPTIONS = [
	{ key: TEST_EVENT_RENDER_MODES.Preferred, label: TEST_EVENT_RENDER_MODES.Preferred },
	{ key: TEST_EVENT_RENDER_MODES.Fallback, label: TEST_EVENT_RENDER_MODES.Fallback }
];
const EXTENSION_MEDIA_MODE = 'extension-media-mode';

describe('resolveActivityEventRenderMode', () => {
	it('keeps a matching media preference on the same event rendering', () => {
		expect(
			resolveActivityEventRenderMode(TEST_EVENT_RENDER_MODES.Preferred, EVENT_RENDER_MODE_OPTIONS)
		).toBe(TEST_EVENT_RENDER_MODES.Preferred);
	});

	it('maps snapshot media preference to the extension fallback event rendering', () => {
		expect(
			resolveActivityEventRenderMode(COLLECTION_MEDIA_MODES.Snapshot, EVENT_RENDER_MODE_OPTIONS)
		).toBe(TEST_EVENT_RENDER_MODES.Fallback);
	});

	it('maps non-artifact media preferences to the extension fallback event rendering', () => {
		expect(resolveActivityEventRenderMode(EXTENSION_MEDIA_MODE, EVENT_RENDER_MODE_OPTIONS)).toBe(
			TEST_EVENT_RENDER_MODES.Fallback
		);
	});

	it('returns the media preference when no event render modes exist', () => {
		expect(resolveActivityEventRenderMode(COLLECTION_MEDIA_MODES.Snapshot, undefined)).toBe(
			COLLECTION_MEDIA_MODES.Snapshot
		);
	});
});
