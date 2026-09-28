import { describe, expect, it, vi } from 'vitest';
import {
	BOOTSTRAP_OPERATION,
	BOOTSTRAP_OUTPUT_STEP,
	BOOTSTRAP_OUTPUT_STATUS,
	BOOTSTRAP_STREAM_RECORD as RecordType,
	BOOTSTRAP_OUTPUT_MAX_ENTRIES,
	BOOTSTRAP_OUTPUT_MAX_BYTES,
	type BootstrapProgressRecord
} from '@artgod/shared/bootstrap/operation-output';
import {
	readBootstrapStream,
	appendBootstrapOutput,
	emptyBootstrapLog,
	BootstrapStreamError
} from './bootstrap-output';

const progress: BootstrapProgressRecord = {
	type: RecordType.Progress,
	operation: BOOTSTRAP_OPERATION.Inspect,
	step: BOOTSTRAP_OUTPUT_STEP.Metadata,
	status: BOOTSTRAP_OUTPUT_STATUS.Started,
	sequence: 1,
	timestamp: '2026-09-28T20:00:00Z',
	message: 'Metadata → download',
	url: 'https://example.com/ipfs/cid/1000?format=json'
};
const result = { type: RecordType.Result, result: { name: 'Token 🌊' } };
function chunked(text: string) {
	const bytes = new TextEncoder().encode(text);
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
				controller.close();
			}
		})
	);
}
describe('bootstrap output protocol', () => {
	it('preserves exact URLs and split unicode while delivering progress before completion', async () => {
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const onOutput = vi.fn();
		const response = new Response(
			new ReadableStream({
				start(value) {
					controller = value;
				}
			})
		);
		const reading = readBootstrapStream(response, onOutput);
		controller.enqueue(new TextEncoder().encode(JSON.stringify(progress) + '\n'));
		await vi.waitFor(() => expect(onOutput).toHaveBeenCalledWith(progress));
		controller.enqueue(new TextEncoder().encode(JSON.stringify(result) + '\n'));
		controller.close();
		expect(await reading).toEqual(result.result);
		expect(
			await readBootstrapStream(
				chunked(JSON.stringify(progress) + '\n' + JSON.stringify(result) + '\n'),
				vi.fn()
			)
		).toEqual(result.result);
	});
	it.each([
		JSON.stringify(progress) + '\n',
		JSON.stringify(result),
		JSON.stringify(result) + '\n' + JSON.stringify(result) + '\n',
		JSON.stringify({ ...progress, sequence: 2 }) + '\n',
		'{broken}\n'
	])('rejects interrupted, malformed and out-of-order streams', async (text) => {
		await expect(readBootstrapStream(chunked(text), vi.fn())).rejects.toBeInstanceOf(
			BootstrapStreamError
		);
	});
	it('retains progress before a terminal mapped failure', async () => {
		const onOutput = vi.fn();
		const text =
			JSON.stringify(progress) +
			'\n' +
			JSON.stringify({
				type: RecordType.Error,
				statusCode: 502,
				error: 'image_cache_estimate_failed',
				message: 'Image unavailable. Retry.'
			}) +
			'\n';
		await expect(readBootstrapStream(chunked(text), onOutput)).rejects.toMatchObject({
			status: 502,
			message: 'Image unavailable. Retry.'
		});
		expect(onOutput).toHaveBeenCalledWith(progress);
	});
	it('bounds both retained entry count and bytes and reports discarded history', () => {
		let log = emptyBootstrapLog();
		for (let i = 0; i < BOOTSTRAP_OUTPUT_MAX_ENTRIES + 3; i++)
			log = appendBootstrapOutput(log, progress);
		expect(log.entries).toHaveLength(BOOTSTRAP_OUTPUT_MAX_ENTRIES);
		expect(log.discarded).toBe(3);
		log = appendBootstrapOutput(log, { ...progress, text: 'x'.repeat(BOOTSTRAP_OUTPUT_MAX_BYTES) });
		expect(log.bytes).toBeLessThanOrEqual(BOOTSTRAP_OUTPUT_MAX_BYTES);
		expect(log.discarded).toBe(BOOTSTRAP_OUTPUT_MAX_ENTRIES + 4);
	});
});
