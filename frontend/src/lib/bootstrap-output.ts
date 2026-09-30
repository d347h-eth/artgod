import {
	BOOTSTRAP_OUTPUT_MAX_BYTES,
	BOOTSTRAP_OUTPUT_MAX_ENTRIES,
	type BootstrapProgressRecord
} from '@artgod/shared/bootstrap/operation-output';
export {
	readBootstrapStream,
	BootstrapStreamError
} from '@artgod/shared/bootstrap/operation-stream';

export type BootstrapRequestOutput = {
	onOutput: (record: BootstrapProgressRecord) => void;
	signal?: AbortSignal;
};

export type BootstrapLogEntry = BootstrapProgressRecord & { id: number; bytes: number };
export type BootstrapLog = {
	entries: BootstrapLogEntry[];
	bytes: number;
	discarded: number;
	nextId: number;
};
export function emptyBootstrapLog(): BootstrapLog {
	return { entries: [], bytes: 0, discarded: 0, nextId: 0 };
}
export function appendBootstrapOutput(
	log: BootstrapLog,
	record: BootstrapProgressRecord
): BootstrapLog {
	const bytes =
		new TextEncoder().encode(record.message + (record.url ?? '') + (record.text ?? '')).byteLength +
		256;
	const entries = [...log.entries, { ...record, bytes, id: log.nextId }];
	let total = log.bytes + bytes;
	let discarded = log.discarded;
	while (entries.length > BOOTSTRAP_OUTPUT_MAX_ENTRIES || total > BOOTSTRAP_OUTPUT_MAX_BYTES) {
		const removed = entries.shift();
		if (!removed) break;
		total -= removed.bytes;
		discarded += 1;
	}
	return { entries, bytes: total, discarded, nextId: log.nextId + 1 };
}
