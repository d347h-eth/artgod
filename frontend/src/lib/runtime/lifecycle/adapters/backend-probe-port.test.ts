import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNTIME_API_ROUTES } from '@artgod/shared/http/runtime-routes';
import { BACKEND_PROBE_CSP_EVENT_CODE, createBackendProbePort } from './backend-probe-port';
import { BACKEND_PROBE_STAGES } from '../ports';
import { getFrontendBuildTarget } from '$lib/runtime/frontend-target';
import { getFrontendDeploymentMode } from '$lib/runtime/public-deployment';

const origin = vi.hoisted(() => ({ resolve: vi.fn(), diagnostics: vi.fn() }));
vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/runtime/backend-origin', () => ({
	resolveBackendOrigin: origin.resolve,
	backendOriginDiagnostics: origin.diagnostics
}));

const backendOrigin = 'http://127.0.0.1:42710';
let documentEvents: EventTarget;
beforeEach(() => {
	vi.clearAllMocks();
	origin.resolve.mockResolvedValue(backendOrigin);
	origin.diagnostics.mockReturnValue({ originResolutionState: 'cached' });
	documentEvents = new EventTarget();
	vi.stubGlobal('document', documentEvents);
	vi.stubGlobal('window', {
		location: {
			origin: 'tauri://localhost',
			protocol: 'tauri:',
			href: 'tauri://localhost/?token=excluded'
		},
		isSecureContext: true
	});
	vi.stubGlobal('navigator', { userAgent: 'fixture-webview', onLine: true });
});
afterEach(() => vi.unstubAllGlobals());

describe('WebView readiness probe diagnostics', () => {
	it('distinguishes endpoint resolution failure from a fetch that was never sent', async () => {
		origin.resolve.mockRejectedValue(
			new Error('Desktop runtime unavailable', { cause: 'config not initialized' })
		);
		const fetchFn = vi.fn<typeof fetch>();
		const probe = createBackendProbePort(fetchFn);
		await expect(probe.probeReady()).rejects.toThrow('Desktop runtime unavailable');
		expect(fetchFn).not.toHaveBeenCalled();
		expect(probe.diagnostics?.()).toMatchObject({
			probeStage: BACKEND_PROBE_STAGES.originResolution,
			causeMessage: 'config not initialized',
			frontendBuildTarget: getFrontendBuildTarget(),
			frontendDeploymentMode: getFrontendDeploymentMode(),
			frontendOrigin: 'tauri://localhost',
			frontendUrl: 'tauri://localhost/'
		});
		probe.dispose?.();
	});

	it('preserves the original WebView exception and request target on fetch rejection', async () => {
		const probe = createBackendProbePort(
			vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Load failed'))
		);
		await expect(probe.probeReady()).rejects.toThrow('Backend readiness probe fetch failed');
		expect(probe.diagnostics?.()).toMatchObject({
			probeStage: BACKEND_PROBE_STAGES.fetch,
			requestUrl: `${backendOrigin}${RUNTIME_API_ROUTES.DefaultChain}`,
			causeName: 'TypeError',
			causeMessage: 'Load failed'
		});
		probe.dispose?.();
	});

	it('records HTTP failure details and clears them when a later request succeeds', async () => {
		const fetchFn = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response('excluded response body', {
					status: 503,
					headers: { 'content-type': 'application/json', 'set-cookie': 'excluded cookie' }
				})
			)
			.mockResolvedValueOnce(new Response('{}', { status: 200 }));
		const probe = createBackendProbePort(fetchFn);
		await expect(probe.probeReady()).rejects.toThrow('status 503');
		expect(probe.diagnostics?.()).toMatchObject({
			probeStage: BACKEND_PROBE_STAGES.response,
			httpStatus: 503,
			contentType: 'application/json'
		});
		expect(JSON.stringify(probe.diagnostics?.())).not.toMatch(/excluded/);
		await probe.probeReady();
		expect(probe.diagnostics?.()).toMatchObject({ httpStatus: 200, probeSequence: 2 });
		expect(probe.diagnostics?.().errorMessage).toBeUndefined();
		probe.dispose?.();
	});

	it('keeps pending-stage and abort diagnostics available when fetch never settles', async () => {
		const probe = createBackendProbePort(
			vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}))
		);
		const abort = new AbortController();
		void probe.probeReady(abort.signal);
		await Promise.resolve();
		abort.abort();
		expect(probe.diagnostics?.()).toMatchObject({
			probeStage: BACKEND_PROBE_STAGES.fetch,
			aborted: true
		});
		probe.dispose?.();
	});

	it('saves a delayed matching CSP event and removes its listener on disposal', async () => {
		const onDiagnostic = vi.fn();
		const probe = createBackendProbePort(
			vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Load failed')),
			onDiagnostic
		);
		await expect(probe.probeReady()).rejects.toThrow();
		const event = new Event('securitypolicyviolation');
		Object.assign(event, {
			effectiveDirective: 'connect-src',
			violatedDirective: 'connect-src',
			disposition: 'enforce',
			originalPolicy: "connect-src 'self'",
			blockedURI: `${backendOrigin}${RUNTIME_API_ROUTES.DefaultChain}`
		});
		documentEvents.dispatchEvent(event);
		expect(onDiagnostic).toHaveBeenCalledWith(
			expect.objectContaining({
				code: BACKEND_PROBE_CSP_EVENT_CODE,
				meta: expect.objectContaining({ cspDisposition: 'enforce' })
			})
		);
		probe.dispose?.();
		documentEvents.dispatchEvent(event);
		expect(onDiagnostic).toHaveBeenCalledOnce();
	});
});
