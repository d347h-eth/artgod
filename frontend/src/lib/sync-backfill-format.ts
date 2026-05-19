const APPROX_BLOCK_SECONDS = 12;
const SECOND_MS = 1_000;
const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;
const DAY_SECONDS = 24 * HOUR_SECONDS;
const MONTH_SECONDS = 30 * DAY_SECONDS;
const YEAR_SECONDS = 365 * DAY_SECONDS;
const ETHEREUM_MAINNET_CHAIN_ID = 1;
const ETHEREUM_MAINNET_GENESIS_TIME_MS = 1_438_269_973_000;

const INTEGER_FORMATTER = new Intl.NumberFormat(undefined, {
	maximumFractionDigits: 0
});

// Formats block counts and block numbers with locale-aware digit grouping.
export function formatSyncBackfillInteger(value: number): string {
	return INTEGER_FORMATTER.format(value);
}

// Formats an inclusive block range with grouped endpoint numbers.
export function formatSyncBackfillBlockRange(fromBlock: number, toBlock: number): string {
	return `${formatSyncBackfillInteger(fromBlock)}-${formatSyncBackfillInteger(toBlock)}`;
}

// Converts a block count to a compact approximate duration at 12 seconds per block.
export function formatSyncBackfillBlockDuration(blockCount: number): string {
	const totalSeconds = Math.max(0, Math.round(blockCount * APPROX_BLOCK_SECONDS));
	if (totalSeconds === 0) return '0s';

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
	if (parts.length === 0) return '0s';
	return parts.join(' ');
}

// Estimates UTC block time from known genesis anchors without adding block timestamp RPC calls.
export function estimateSyncBackfillBlockTimeMs(input: {
	blockNumber: number;
	chainPublicId: number;
	headBlock: number;
	headTimeMs: number;
}): number {
	const genesisTimeMs = resolveSyncBackfillGenesisTimeMs(input);
	if (input.headBlock <= 0) return genesisTimeMs;

	const boundedBlock = Math.max(0, Math.min(input.blockNumber, input.headBlock));
	const chainElapsedMs = input.headTimeMs - genesisTimeMs;
	const blockRatio = boundedBlock / input.headBlock;
	return genesisTimeMs + Math.round(chainElapsedMs * blockRatio);
}

// Formats approximate UTC time without timezone suffix or subseconds.
export function formatSyncBackfillApproxUtc(valueMs: number): string {
	return new Date(valueMs).toISOString().replace(/\.\d{3}Z$/, '');
}

// Formats an approximate inclusive UTC time range for visible block endpoints.
export function formatSyncBackfillApproxTimeRange(input: {
	fromBlock: number;
	toBlock: number;
	chainPublicId: number;
	headBlock: number;
	headTimeMs: number;
}): string {
	const fromMs = estimateSyncBackfillBlockTimeMs({
		blockNumber: input.fromBlock,
		chainPublicId: input.chainPublicId,
		headBlock: input.headBlock,
		headTimeMs: input.headTimeMs
	});
	const toMs = estimateSyncBackfillBlockTimeMs({
		blockNumber: input.toBlock,
		chainPublicId: input.chainPublicId,
		headBlock: input.headBlock,
		headTimeMs: input.headTimeMs
	});
	return `${formatSyncBackfillApproxUtc(fromMs)} / ${formatSyncBackfillApproxUtc(toMs)}`;
}

// Formats integer synced percentage for range summary chips.
export function formatSyncBackfillSyncedPercent(syncedCount: number, blockCount: number): string {
	if (blockCount <= 0) return '0%';
	return `${Math.round((syncedCount / blockCount) * 100)}%`;
}

function appendDurationPart(parts: string[], value: number, suffix: string): void {
	if (value > 0) {
		parts.push(`${value}${suffix}`);
	}
}

function resolveSyncBackfillGenesisTimeMs(input: {
	chainPublicId: number;
	headBlock: number;
	headTimeMs: number;
}): number {
	if (input.chainPublicId === ETHEREUM_MAINNET_CHAIN_ID) {
		return ETHEREUM_MAINNET_GENESIS_TIME_MS;
	}
	return input.headTimeMs - input.headBlock * APPROX_BLOCK_SECONDS * SECOND_MS;
}
