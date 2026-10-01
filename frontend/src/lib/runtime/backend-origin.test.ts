import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('$app/environment', () => ({ browser: true }));
afterEach(() => vi.unstubAllGlobals());

describe('backend origin cache diagnostics', () => {
	it('identifies the original cached IPC rejection on repeated readiness attempts', async () => {
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
		await expect(resolver.resolveBackendOrigin()).rejects.toThrow('config not initialized');
		// Starting the native runtime does not clear the existing rejected module promise.
		initialized = true;
		await expect(resolver.resolveBackendOrigin()).rejects.toThrow('config not initialized');
		expect(invoke).toHaveBeenCalledTimes(2); // One endpoints call plus its status context lookup.
		expect(resolver.backendOriginDiagnostics()).toMatchObject({
			originResolutionState: 'rejected',
			originResolutionAttempts: 1,
			originResolutionCause: 'desktop runtime config not initialized',
			originBridgeAvailable: true
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
		expect(resolver.backendOriginDiagnostics().originResolutionState).toBe('pending');
		resolveEndpoints({ backendHttpBaseUrl: 'http://127.0.0.1:42710' });
		await first;
		expect(resolver.backendOriginDiagnostics().originResolutionState).toBe('cached');
		await resolver.resolveBackendOrigin();
		expect(invoke).toHaveBeenCalledOnce();
	});
});
