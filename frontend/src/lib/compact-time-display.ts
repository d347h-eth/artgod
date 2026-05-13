// Shared compact time modes used by dense table and form metadata controls.
export type CompactTimeDisplayMode = 'relative' | 'absolute';

// Parses optional API timestamps into milliseconds for compact UI time labels.
export function parseCompactTimeMs(value: string | null | undefined): number | null {
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

// Formats timestamps as RFC 3339 without milliseconds for human-facing absolute time.
export function formatRfc3339(valueMs: number): string {
	return new Date(valueMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Formats a timestamp as a compact relative delta without noisy ago/in suffixes.
export function formatCompactRelativeTime(valueMs: number, nowMs: number): string {
	const diffSeconds = Math.round((valueMs - nowMs) / 1000);
	const absoluteSeconds = Math.abs(diffSeconds);
	if (absoluteSeconds < 5) return 'now';
	if (absoluteSeconds < 60) return `${absoluteSeconds}s`;
	if (absoluteSeconds < 3600) return `${Math.floor(absoluteSeconds / 60)}m`;
	if (absoluteSeconds < 86_400) return `${Math.floor(absoluteSeconds / 3600)}h`;
	return `${Math.floor(absoluteSeconds / 86_400)}d`;
}

// Formats a timestamp in the selected compact UI mode.
export function formatCompactTime(
	valueMs: number | null,
	mode: CompactTimeDisplayMode,
	nowMs: number
): string {
	if (valueMs === null) return '-';
	return mode === 'absolute' ? formatRfc3339(valueMs) : formatCompactRelativeTime(valueMs, nowMs);
}

// Provides the opposite timestamp representation for title tooltips.
export function oppositeCompactTimeTitle(
	valueMs: number | null,
	mode: CompactTimeDisplayMode,
	nowMs: number
): string | undefined {
	if (valueMs === null) return undefined;
	return mode === 'relative' ? formatRfc3339(valueMs) : formatCompactRelativeTime(valueMs, nowMs);
}

// Labels the compact time-mode toggle buttons.
export function compactTimeModeLabel(mode: CompactTimeDisplayMode): string {
	return mode === 'relative' ? 'rel' : 'abs';
}
