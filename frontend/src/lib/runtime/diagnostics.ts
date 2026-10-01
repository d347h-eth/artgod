import type { LifecycleEvent, LifecycleEventMeta } from './lifecycle/core/types';
import type { RuntimeStatus } from './lifecycle/ports';

// Mirrors the bounded scalar input accepted by desktop_diagnostics.rs.
export type RuntimeDiagnostic = {
	sessionId: string;
	eventId: number;
	clientAtIso: string;
	level: LifecycleEvent['level'];
	code: string;
	message: string;
	meta: LifecycleEventMeta;
	compareBackend?: boolean;
};

export interface RuntimeDiagnosticsPort {
	write(diagnostic: RuntimeDiagnostic): Promise<void>;
}

const MAX_PENDING_DIAGNOSTICS = 200;
const MAX_TEXT_LENGTH = 1000;

/** Keep credentials, query values and fragments out of request/page URL context. */
export function diagnosticUrl(value: string): string {
	try {
		const url = new URL(value);
		const needsSanitizing = Boolean(url.username || url.password || url.search || url.hash);
		url.username = '';
		url.password = '';
		url.search = '';
		url.hash = '';
		return needsSanitizing ? url.href : value;
	} catch {
		const withoutQuery = value.split(/[?#]/, 1)[0];
		if (/^[a-z][a-z\d+.-]*:\/\//i.test(withoutQuery)) {
			// CSP source expressions such as http://localhost:* are not parseable URLs.
			return withoutQuery.replace(/^([a-z][a-z\d+.-]*:\/\/)[^/]*@/i, '$1');
		}
		return value.startsWith('/') ? withoutQuery : '';
	}
}

export function diagnosticText(value: string): string {
	// Error stacks can contain page/request URLs, including query tokens.
	return value
		.replace(/[a-z][a-z\d+.-]*:\/\/[^\s)"'<>]+/gi, (url) => diagnosticUrl(url))
		.slice(0, MAX_TEXT_LENGTH);
}

export function diagnosticError(error: unknown): LifecycleEventMeta {
	const result: LifecycleEventMeta = {
		errorName: error instanceof Error ? error.name : typeof error,
		errorMessage: diagnosticText(
			error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error'
		)
	};
	if (error instanceof Error) {
		if (error.stack) result.errorStack = diagnosticText(error.stack);
		if (error.cause !== undefined) {
			const cause = error.cause;
			result.causeName = cause instanceof Error ? cause.name : typeof cause;
			result.causeMessage = diagnosticText(
				cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : 'unknown cause'
			);
			if (cause instanceof Error && cause.stack) result.causeStack = diagnosticText(cause.stack);
		}
	}
	return result;
}

/** Buffer boot events until IPC is ready; file I/O never gates readiness or Stop. */
export function createLifecycleDiagnostics(
	port: RuntimeDiagnosticsPort,
	buildContext: Readonly<LifecycleEventMeta> = {}
) {
	const sessionId =
		globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const pending: RuntimeDiagnostic[] = [];
	let available = false;
	let nextEventId = 1;
	let droppedEvents = 0;
	let inFlight = 0;
	let warned = false;

	function sendPending() {
		if (!available) return;
		while (pending.length && inFlight < MAX_PENDING_DIAGNOSTICS) {
			const diagnostic = pending.shift()!;
			if (droppedEvents) {
				diagnostic.meta.droppedDiagnosticEvents = droppedEvents;
				droppedEvents = 0;
			}
			inFlight += 1;
			// Independent writes let a final failure cross IPC even if an earlier invocation hangs.
			void Promise.resolve()
				.then(() => port.write(diagnostic))
				.catch((error: unknown) => {
					droppedEvents += 1;
					if (!warned) {
						warned = true;
						console.warn('Desktop lifecycle log write failed', diagnosticError(error));
					}
				})
				.finally(() => {
					inFlight -= 1;
					sendPending();
				});
		}
	}

	return {
		setAvailable(value: boolean) {
			available = value;
			sendPending();
		},
		record(event: Omit<LifecycleEvent, 'id'> & { id?: number }, status: RuntimeStatus | null) {
			const meta: LifecycleEventMeta = {
				...buildContext,
				...event.meta,
				observedRuntimeState: status?.state ?? 'unavailable',
				observedOperationId: status?.operationId ?? -1,
				observedRevision: status?.revision ?? -1,
				observedBackendOrigin: diagnosticUrl(status?.backendHttpBaseUrl ?? '')
			};
			if (event.id !== undefined) meta.lifecycleEventId = event.id;
			for (const [key, value] of Object.entries(meta)) {
				if (typeof value === 'string') meta[key] = diagnosticText(value);
			}
			if (pending.length >= MAX_PENDING_DIAGNOSTICS) {
				pending.shift();
				droppedEvents += 1;
			}
			pending.push({
				sessionId,
				eventId: nextEventId++,
				clientAtIso: event.atIso,
				level: event.level,
				code: event.code,
				message: diagnosticText(event.message),
				meta
			});
			sendPending();
		}
	};
}
