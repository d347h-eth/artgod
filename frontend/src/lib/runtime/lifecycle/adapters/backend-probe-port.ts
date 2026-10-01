import { browser } from '$app/environment';
import { RUNTIME_API_ROUTES } from '@artgod/shared/http/runtime-routes';
import { backendOriginDiagnostics, resolveBackendOrigin } from '$lib/runtime/backend-origin';
import { getFrontendBuildTarget } from '$lib/runtime/frontend-target';
import { getFrontendDeploymentMode, PUBLIC_COLLECTION_SCOPE } from '$lib/runtime/public-deployment';
import { diagnosticError, diagnosticUrl } from '../../diagnostics';
import type { LifecycleEvent, LifecycleEventMeta } from '../core/types';
import { BACKEND_PROBE_STAGES, type BackendProbePort } from '../ports';
export const BACKEND_PROBE_CSP_EVENT_CODE = 'api.request.csp';
const CONNECT_SRC_DIRECTIVE = 'connect-src';

type ProbeDiagnosticObserver = (event: Omit<LifecycleEvent, 'id'>) => void;

export function createBackendProbePort(
	fetchFn: typeof fetch = fetch,
	onDiagnostic?: ProbeDiagnosticObserver
): BackendProbePort {
	let latest: LifecycleEventMeta = {};
	let startedAtMs = 0;
	let sequence = 0;
	let cspListenerInstalled = false;
	let activeSignal: AbortSignal | undefined;

	function diagnostics(): LifecycleEventMeta {
		return {
			...latest,
			...backendOriginDiagnostics(),
			aborted: activeSignal?.aborted ?? false,
			probeElapsedMs: sequence ? Math.max(0, Date.now() - startedAtMs) : 0
		};
	}

	function onCspViolation(event: SecurityPolicyViolationEvent) {
		if (event.effectiveDirective !== CONNECT_SRC_DIRECTIVE || !latest.requestUrl) return;
		try {
			// Browsers may omit the blocked path for a cross-origin CSP violation.
			if (new URL(event.blockedURI).origin !== new URL(String(latest.requestUrl)).origin) return;
		} catch {
			return;
		}
		Object.assign(latest, {
			cspBlockedUri: diagnosticUrl(event.blockedURI),
			cspEffectiveDirective: event.effectiveDirective,
			cspViolatedDirective: event.violatedDirective,
			cspDisposition: event.disposition,
			cspOriginalPolicy: event.originalPolicy
		});
		try {
			onDiagnostic?.({
				atIso: new Date().toISOString(),
				level: 'warn',
				code: BACKEND_PROBE_CSP_EVENT_CODE,
				message: 'WebView reported a content security policy violation for the readiness request',
				meta: diagnostics()
			});
		} catch {
			// Diagnostic observers must not affect the browser request.
		}
	}

	return {
		diagnostics,
		dispose() {
			if (cspListenerInstalled)
				document.removeEventListener('securitypolicyviolation', onCspViolation);
			cspListenerInstalled = false;
		},
		async probeReady(signal?: AbortSignal): Promise<void> {
			sequence += 1;
			startedAtMs = Date.now();
			activeSignal = signal;
			const current: LifecycleEventMeta = {
				probeSequence: sequence,
				probeStage: BACKEND_PROBE_STAGES.originResolution,
				frontendBuildTarget: getFrontendBuildTarget(),
				frontendDeploymentMode: getFrontendDeploymentMode(),
				publicChainRef: PUBLIC_COLLECTION_SCOPE?.chainRef ?? '',
				publicCollectionRef: PUBLIC_COLLECTION_SCOPE?.collectionRef ?? '',
				frontendOrigin: browser ? window.location.origin : 'server',
				frontendUrl: browser ? diagnosticUrl(window.location.href) : '',
				frontendProtocol: browser ? window.location.protocol : '',
				userAgent: browser ? navigator.userAgent : '',
				online: browser ? navigator.onLine : true,
				secureContext: browser ? window.isSecureContext : false,
				requestPath: RUNTIME_API_ROUTES.DefaultChain,
				requestMode: 'cors',
				requestCredentials: 'same-origin',
				aborted: signal?.aborted ?? false
			};
			latest = current;
			if (browser && !cspListenerInstalled) {
				document.addEventListener('securitypolicyviolation', onCspViolation);
				cspListenerInstalled = true;
			}
			try {
				const backendOrigin = await resolveBackendOrigin();
				current.backendOrigin = diagnosticUrl(backendOrigin);
				current.requestUrl = diagnosticUrl(`${backendOrigin}${RUNTIME_API_ROUTES.DefaultChain}`);
				current.probeStage = BACKEND_PROBE_STAGES.fetch;
				let response: Response;
				try {
					response = await fetchFn(`${backendOrigin}${RUNTIME_API_ROUTES.DefaultChain}`, {
						signal
					});
				} catch (cause) {
					throw new Error(
						`Backend readiness probe fetch failed (${describeProbeContext(backendOrigin)}): ${toErrorMessage(cause)}`,
						{ cause }
					);
				}
				Object.assign(current, {
					probeStage: BACKEND_PROBE_STAGES.response,
					httpStatus: response.status,
					httpStatusText: response.statusText,
					responseType: response.type,
					responseUrl: diagnosticUrl(response.url),
					redirected: response.redirected,
					contentType: response.headers.get('content-type') ?? ''
				});
				if (!response.ok) {
					throw new Error(
						`Backend readiness probe failed with status ${response.status} (${describeProbeContext(backendOrigin)})`
					);
				}
			} catch (error) {
				Object.assign(current, diagnosticError(error));
				throw error;
			} finally {
				current.aborted = signal?.aborted ?? false;
			}
		}
	};
}

function describeProbeContext(backendOrigin: string): string {
	const frontendOrigin = browser ? window.location.origin : 'server';
	return `frontendOrigin=${frontendOrigin}, backendOrigin=${backendOrigin}`;
}

function toErrorMessage(value: unknown): string {
	if (value instanceof Error && value.message.trim()) {
		return value.message;
	}
	if (typeof value === 'string' && value.trim()) {
		return value;
	}
	return 'unknown error';
}
