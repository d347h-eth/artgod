import { resolveBackendOrigin } from '$lib/runtime/backend-origin';
import type { BackendProbePort } from '../ports';

export function createBackendProbePort(fetchFn: typeof fetch = fetch): BackendProbePort {
	return {
		async probeReady(): Promise<void> {
			const backendOrigin = await resolveBackendOrigin();
			const response = await fetchFn(`${backendOrigin}/api/chains/default`);
			if (!response.ok) {
				throw new Error(`Backend readiness probe failed with status ${response.status}`);
			}
		}
	};
}
