const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;
const DAY_SECONDS = 24 * HOUR_SECONDS;
const MONTH_SECONDS = 30 * DAY_SECONDS;
const YEAR_SECONDS = 365 * DAY_SECONDS;

const INTEGER_FORMATTER = new Intl.NumberFormat(undefined, {
	maximumFractionDigits: 0
});

type DurationFormatOptions = {
	approximate?: boolean;
};

// Formats block counts and block numbers with locale-aware digit grouping.
export function formatBlockspaceInteger(value: number): string {
	return INTEGER_FORMATTER.format(value);
}

// Formats an inclusive block range with grouped endpoint numbers.
export function formatBlockspaceBlockRange(fromBlock: number, toBlock: number): string {
	return `${formatBlockspaceInteger(fromBlock)}-${formatBlockspaceInteger(toBlock)}`;
}

// Formats an anchored elapsed duration in compact units.
export function formatBlockspaceDurationSeconds(
	durationSeconds: number | null,
	options: DurationFormatOptions = {}
): string {
	if (durationSeconds === null || !Number.isFinite(durationSeconds)) return 'unknown';

	const totalSeconds = Math.max(0, Math.round(durationSeconds));
	const prefix = options.approximate ? '~' : '';
	if (totalSeconds === 0) return `${prefix}0s`;

	const years = Math.floor(totalSeconds / YEAR_SECONDS);
	const afterYears = totalSeconds % YEAR_SECONDS;
	const months = Math.floor(afterYears / MONTH_SECONDS);
	const afterMonths = afterYears % MONTH_SECONDS;
	const days = Math.floor(afterMonths / DAY_SECONDS);
	const afterDays = afterMonths % DAY_SECONDS;
	const hours = Math.floor(afterDays / HOUR_SECONDS);
	const afterHours = afterDays % HOUR_SECONDS;
	const minutes = Math.floor(afterHours / MINUTE_SECONDS);
	const seconds = afterHours % MINUTE_SECONDS;
	const parts: string[] = [];

	appendDurationPart(parts, years, 'y');
	appendDurationPart(parts, months, 'm');
	appendDurationPart(parts, days, 'd');
	appendDurationPart(parts, hours, 'h');
	if (parts.length === 0) {
		appendDurationPart(parts, minutes, 'min');
		appendDurationPart(parts, seconds, 's');
	}
	if (parts.length === 0) return `${prefix}0s`;
	return `${prefix}${parts.join(' ')}`;
}

// Derives a visible block span duration from the current page's anchored endpoints.
export function formatBlockspaceAnchoredBlockDuration(input: {
	blockCount: number;
	pageBlockCount: number;
	pageDurationSeconds: number | null;
	averageBlockTimeSeconds: number | null | undefined;
}): string {
	if (input.blockCount <= 0) return '0s';
	if (input.blockCount === 1) {
		return formatApproximateBlockDuration(input.averageBlockTimeSeconds);
	}
	if (input.pageDurationSeconds === null || input.pageBlockCount <= 1) return 'unknown';

	const pageIntervals = input.pageBlockCount - 1;
	const blockIntervals = input.blockCount - 1;
	const durationSeconds = (input.pageDurationSeconds * blockIntervals) / pageIntervals;
	return formatBlockspaceDurationSeconds(durationSeconds);
}

// Formats an anchored UTC timestamp without timezone suffix or subseconds.
export function formatBlockspaceUtc(timestampSeconds: number | null): string {
	if (timestampSeconds === null || !Number.isFinite(timestampSeconds)) return 'unknown';
	return new Date(timestampSeconds * 1_000).toISOString().replace(/\.\d{3}Z$/, '');
}

// Formats the anchored UTC time range for the visible block endpoints.
export function formatBlockspaceTimeRange(input: {
	fromTimestamp: number | null;
	toTimestamp: number | null;
}): string {
	return `${formatBlockspaceUtc(input.fromTimestamp)} / ${formatBlockspaceUtc(input.toTimestamp)}`;
}

// Formats integer synced percentage for range summary chips.
export function formatBlockspaceSyncedPercent(syncedCount: number, blockCount: number): string {
	if (blockCount <= 0) return '0%';
	return `${Math.round((syncedCount / blockCount) * 100)}%`;
}

function appendDurationPart(parts: string[], value: number, suffix: string): void {
	if (value > 0) {
		parts.push(`${value}${suffix}`);
	}
}

function formatApproximateBlockDuration(
	averageBlockTimeSeconds: number | null | undefined
): string {
	if (
		averageBlockTimeSeconds === null ||
		averageBlockTimeSeconds === undefined ||
		!Number.isFinite(averageBlockTimeSeconds) ||
		averageBlockTimeSeconds <= 0
	) {
		return 'unknown';
	}
	return formatBlockspaceDurationSeconds(averageBlockTimeSeconds, { approximate: true });
}
