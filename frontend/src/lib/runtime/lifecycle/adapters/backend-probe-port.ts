import { browser } from '$app/environment';
import { resolveBackendOrigin } from '$lib/runtime/backend-origin';
import type { BackendProbePort } from '../ports';

export function createBackendProbePort(fetchFn: typeof fetch = fetch): BackendProbePort {
	return {
		async probeReady(): Promise<void> {
			const backendOrigin = await resolveBackendOrigin();
			let response: Response;
			try {
				response = await fetchFn(`${backendOrigin}/api/chains/default`);
			} catch (cause) {
				throw new Error(
					`Backend readiness probe fetch failed (${describeProbeContext(
						backendOrigin
					)}): ${toErrorMessage(cause)}`
				);
			}
			if (!response.ok) {
				throw new Error(
					`Backend readiness probe failed with status ${response.status} (${describeProbeContext(
						backendOrigin
					)})`
				);
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
