import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_DEPLOYMENT_MODE } from '@artgod/shared/config/deployment';
import {
	createLifecycleDiagnostics,
	diagnosticError,
	diagnosticText,
	diagnosticUrl,
	type RuntimeDiagnostic
} from './diagnostics';

const event = {
	atIso: '2026-10-01T19:29:12.000Z',
	level: 'warn' as const,
	code: 'api.retry',
	message: 'Retrying',
	meta: { attempt: 1 }
};
async function flush() {
	for (let i = 0; i < 15; i++) await Promise.resolve();
}
afterEach(() => vi.restoreAllMocks());

describe('persisted lifecycle diagnostics', () => {
	it('saves compiled deployment and revision context on boot before a backend probe is made', async () => {
		const written: RuntimeDiagnostic[] = [];
		const buildContext = {
			frontendVersion: 'v0.1.2-alpha.3',
			frontendCommit: '1234567890abcdef1234567890abcdef12345678',
			frontendBuildTarget: 'admin',
			frontendDeploymentMode: APP_DEPLOYMENT_MODE.PublicSingleCollection
		};
		const diagnostics = createLifecycleDiagnostics(
			{
				async write(record) {
					written.push(record);
				}
			},
			buildContext
		);
		diagnostics.record({ ...event, code: 'boot.session.started', meta: {} }, null);
		diagnostics.setAvailable(true);
		await flush();
		expect(written[0].meta).toMatchObject(buildContext);
		expect(written[0].meta.observedRuntimeState).toBe('unavailable');
	});

	it('buffers boot events, preserves session identity and copies metadata before async writes', async () => {
		const written: RuntimeDiagnostic[] = [];
		const diagnostics = createLifecycleDiagnostics({
			async write(record) {
				written.push(record);
			}
		});
		const input = { ...event, meta: { attempt: 1 } };
		diagnostics.record(input, null);
		input.meta.attempt = 9;
		await flush();
		expect(written).toHaveLength(0);
		diagnostics.setAvailable(true);
		diagnostics.record(event, null);
		await flush();
		expect(written.map((record) => record.eventId)).toEqual([1, 2]);
		expect(written[0].sessionId).toBe(written[1].sessionId);
		expect(written[0].meta.attempt).toBe(1);
	});

	it('allows final failures to be written while an earlier IPC write hangs or rejects', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const written: RuntimeDiagnostic[] = [];
		const diagnostics = createLifecycleDiagnostics({
			async write(record) {
				written.push(record);
				if (record.eventId === 1) await new Promise(() => {});
				if (record.eventId === 2) throw new Error('write failed');
			}
		});
		diagnostics.setAvailable(true);
		diagnostics.record(event, null);
		diagnostics.record(event, null);
		await flush();
		diagnostics.record({ ...event, level: 'error', code: 'api.request.fail.final' }, null);
		await flush();
		expect(written.at(-1)?.level).toBe('error');
		expect(written.at(-1)?.meta.droppedDiagnosticEvents).toBe(1);
		expect(warn).toHaveBeenCalledOnce();
	});

	it('bounds boot buffering and identifies dropped events in the next saved record', async () => {
		const written: RuntimeDiagnostic[] = [];
		const diagnostics = createLifecycleDiagnostics({
			async write(record) {
				written.push(record);
			}
		});
		for (let i = 0; i < 220; i++) diagnostics.record(event, null);
		diagnostics.setAvailable(true);
		await flush();
		expect(written).toHaveLength(200);
		expect(written[0].meta.droppedDiagnosticEvents).toBe(20);
	});

	it('omits URL credentials, query tokens and fragments without changing the actual origin', () => {
		expect(diagnosticUrl('http://127.0.0.1:42710')).toBe('http://127.0.0.1:42710');
		expect(diagnosticUrl('https://user:pass@host.example/api?token=secret#secret')).toBe(
			'https://host.example/api'
		);
		const error = new Error('Failed https://user:pass@host.example/api?token=secret', {
			cause: new TypeError('Load failed')
		});
		const metadata = diagnosticError(error);
		expect(metadata.causeName).toBe('TypeError');
		expect(metadata.causeMessage).toBe('Load failed');
		expect(JSON.stringify(metadata)).not.toMatch(/secret|user:pass/);
		expect(diagnosticText('connect-src http://127.0.0.1:* http://localhost:*')).toBe(
			'connect-src http://127.0.0.1:* http://localhost:*'
		);
		expect(diagnosticUrl('http://user:pass@localhost:*/api?token=secret')).toBe(
			'http://localhost:*/api'
		);
	});
});
