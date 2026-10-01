import { afterEach, expect, it, vi } from 'vitest';
import { createTauriDiagnosticsPort } from './tauri-runtime-port';
import type { RuntimeDiagnostic } from '../../diagnostics';
import { LIFECYCLE_API_EVENT_CODES } from '../orchestrator';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

it('sends the structured diagnostic through the native IPC wire contract', async () => {
	vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
	const diagnostic: RuntimeDiagnostic = {
		sessionId: 'test-session',
		eventId: 3,
		clientAtIso: '2026-10-01T19:29:12.000Z',
		level: 'warn',
		code: 'api.retry',
		message: 'Retrying backend request',
		meta: { attempt: 1, frontendOrigin: 'tauri://localhost', aborted: false }
	};
	await createTauriDiagnosticsPort().write(diagnostic);
	// This literal asserts serialization at the Rust command boundary.
	expect(invoke).toHaveBeenCalledWith('runtime_log_lifecycle', { diagnostic });
});

it('requests native comparison only for the first retry and final failure of each readiness operation', async () => {
	vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
	const port = createTauriDiagnosticsPort();
	const diagnostic: RuntimeDiagnostic = {
		sessionId: 'fixture',
		eventId: 1,
		clientAtIso: '2026-10-01T19:29:12.000Z',
		level: 'warn',
		code: LIFECYCLE_API_EVENT_CODES.retry,
		message: 'Retrying',
		meta: { attempt: 1, readinessOperationId: 1, runtimeOperationId: 7 }
	};
	await port.write(diagnostic);
	await port.write({ ...diagnostic, meta: { ...diagnostic.meta, attempt: 2 } });
	const final = { ...diagnostic, code: LIFECYCLE_API_EVENT_CODES.failure, level: 'error' as const };
	await port.write(final);
	await port.write(final);
	await port.write({ ...diagnostic, meta: { ...diagnostic.meta, readinessOperationId: 2 } });
	expect(invoke.mock.calls.map((call) => call[1].diagnostic.compareBackend ?? false)).toEqual([
		true,
		false,
		true,
		false,
		true
	]);
});
