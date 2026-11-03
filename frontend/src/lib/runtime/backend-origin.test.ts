import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('$app/env', () => ({ browser: true }));
afterEach(() => vi.unstubAllGlobals());

describe('backend origin cache diagnostics', () => {
	it('retries after an early IPC rejection and caches the initialized runtime origin', async () => {
		vi.resetModules();
		let initialized = false;
		const invoke = vi.fn(async (command: string) => {
			if (command === 'runtime_get_endpoints') {
				if (!initialized) throw 'desktop runtime config not initialized';
				return { backendHttpBaseUrl: 'http://127.0.0.1:42710' };
			}
			return { state: initialized ? 'running' : 'stopped', lastError: null };
		});
		vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
		const resolver = await import('./backend-origin');
		const earlyLookups = [resolver.resolveBackendOrigin(), resolver.resolveBackendOrigin()];
		await expect(Promise.all(earlyLookups)).rejects.toThrow('config not initialized');
		expect(invoke).toHaveBeenCalledTimes(2); // One endpoints call plus its status context lookup.
		expect(resolver.backendOriginDiagnostics()).toMatchObject({
			originResolutionState: 'rejected',
			originResolutionAttempts: 1,
			originResolutionCause: 'desktop runtime config not initialized',
			originBridgeAvailable: true
		});

		initialized = true;
		const retry = resolver.resolveBackendOrigin();
		const concurrentRetry = resolver.resolveBackendOrigin();
		expect(resolver.backendOriginDiagnostics()).toMatchObject({
			originResolutionState: 'pending',
			originResolutionAttempts: 2,
			originResolutionError: '',
			originResolutionCause: ''
		});
		await expect(Promise.all([retry, concurrentRetry])).resolves.toEqual([
			'http://127.0.0.1:42710',
			'http://127.0.0.1:42710'
		]);
		await expect(resolver.resolveBackendOrigin()).resolves.toBe('http://127.0.0.1:42710');
		expect(invoke).toHaveBeenCalledTimes(3);
		expect(resolver.backendOriginDiagnostics()).toMatchObject({
			originResolutionState: 'cached',
			originResolutionAttempts: 2,
			originResolutionError: '',
			originResolutionCause: ''
		});
	});

	it('identifies pending IPC separately from a resolved cached origin', async () => {
		vi.resetModules();
		let resolveEndpoints!: (endpoints: { backendHttpBaseUrl: string }) => void;
		const invoke = vi.fn(
			() =>
				new Promise((resolve) => {
					resolveEndpoints = resolve;
				})
		);
		vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
		const resolver = await import('./backend-origin');
		const first = resolver.resolveBackendOrigin();
		const second = resolver.resolveBackendOrigin();
		expect(resolver.backendOriginDiagnostics().originResolutionState).toBe('pending');
		resolveEndpoints({ backendHttpBaseUrl: 'http://127.0.0.1:42710' });
		await Promise.all([first, second]);
		expect(resolver.backendOriginDiagnostics().originResolutionState).toBe('cached');
		await resolver.resolveBackendOrigin();
		expect(invoke).toHaveBeenCalledOnce();
	});

	it('caches the empty same-origin value for browser deployments', async () => {
		vi.resetModules();
		vi.stubGlobal('window', {});
		const resolver = await import('./backend-origin');
		await expect(resolver.resolveBackendOrigin()).resolves.toBe('');
		await expect(resolver.resolveBackendOrigin()).resolves.toBe('');
		expect(resolver.backendOriginDiagnostics()).toMatchObject({
			originResolutionState: 'cached',
			originResolutionAttempts: 1,
			originBridgeAvailable: false
		});
	});
});
