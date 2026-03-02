import type { RuntimeStatus } from '../ports';
import type { LifecycleAction, LifecycleConfig, LifecycleEvent, LifecycleState } from './types';

const DEFAULT_EVENT_LIMIT = 200;

export function createInitialLifecycleState(
	desktopShellExpected: boolean,
	startedAtMs: number
): LifecycleState {
	if (desktopShellExpected) {
		return {
			phase: 'booting',
			currentAction: 'Launching desktop runtime...',
			startedAtMs,
			apiReady: false,
			stoppingLockActive: false,
			nextEventId: 1,
			events: []
		};
	}

	return {
		phase: 'ready',
		currentAction: 'Web runtime mode',
		startedAtMs,
		apiReady: true,
		stoppingLockActive: false,
		nextEventId: 1,
		events: []
	};
}

export function reduceLifecycle(
	state: LifecycleState,
	action: LifecycleAction,
	config?: Partial<LifecycleConfig>
): LifecycleState {
	const eventLimit = config?.eventLimit ?? DEFAULT_EVENT_LIMIT;

	switch (action.type) {
		case 'BOOT_RESET':
			return {
				...state,
				phase: 'booting',
				currentAction: action.currentAction,
				startedAtMs: action.startedAtMs,
				apiReady: false,
				stoppingLockActive: false
			};
		case 'SET_STOPPING':
			return {
				...state,
				phase: 'stopping',
				currentAction: action.currentAction,
				startedAtMs: action.startedAtMs,
				stoppingLockActive: true
			};
		case 'SET_FATAL':
			return {
				...state,
				phase: 'fatal',
				currentAction: action.currentAction,
				startedAtMs: action.startedAtMs
			};
		case 'API_READY': {
			const next: LifecycleState = {
				...state,
				apiReady: true
			};
			if (!next.stoppingLockActive) {
				return {
					...next,
					phase: 'ready',
					currentAction: 'Runtime ready',
					startedAtMs: action.startedAtMs
				};
			}
			return next;
		}
		case 'APPEND_EVENT':
			return appendLifecycleEvent(state, action.event, eventLimit);
		case 'APPLY_RUNTIME_STATUS':
			return applyRuntimeStatus(
				state,
				action.status,
				action.previous,
				action.startedAtMs,
				eventLimit
			);
		default:
			return state;
	}
}

function applyRuntimeStatus(
	state: LifecycleState,
	status: RuntimeStatus,
	previous: RuntimeStatus | null,
	nowMs: number,
	eventLimit: number
): LifecycleState {
	if (state.stoppingLockActive && status.state !== 'stopping' && status.state !== 'stopped') {
		return state;
	}

	const statusChanged =
		previous?.state !== status.state ||
		previous?.restartCount !== status.restartCount ||
		previous?.lastError !== status.lastError;

	let next = state;

	if (status.state === 'stopping') {
		next = {
			...next,
			phase: 'stopping',
			currentAction: 'Shutting down local runtime processes...',
			startedAtMs: nowMs,
			stoppingLockActive: true
		};
		if (statusChanged) {
			next = appendRuntimeStateEvent(
				next,
				'info',
				'runtime.state.stopping',
				'Runtime status changed to stopping',
				eventLimit
			);
		}
		return next;
	}

	if (status.state === 'stopped' && next.stoppingLockActive) {
		next = {
			...next,
			phase: 'stopping',
			currentAction: 'Runtime stopped. Finalizing shutdown...',
			stoppingLockActive: false
		};
		if (statusChanged) {
			next = appendRuntimeStateEvent(
				next,
				'info',
				'runtime.state.stopped',
				'Runtime status changed to stopped',
				eventLimit
			);
		}
		return next;
	}

	if (status.state === 'running') {
		next = {
			...next,
			phase: next.apiReady ? 'ready' : 'booting',
			currentAction: next.apiReady
				? 'Runtime ready'
				: 'Runtime running. Waiting for first backend API response...',
			startedAtMs: next.apiReady ? nowMs : next.startedAtMs,
			stoppingLockActive: false
		};
		if (statusChanged) {
			next = appendRuntimeStateEvent(
				next,
				'info',
				'runtime.state.running',
				'Runtime status changed to running',
				eventLimit
			);
		}
		return next;
	}

	if (status.state === 'restarting') {
		next = {
			...next,
			phase: 'booting',
			currentAction: `Runtime restarting (attempt ${status.restartCount})...`,
			startedAtMs: next.startedAtMs,
			apiReady: false,
			stoppingLockActive: false
		};
		if (statusChanged) {
			next = appendLifecycleEvent(
				next,
				createEvent('warn', 'runtime.state.restarting', 'Runtime status changed to restarting', {
					restartCount: status.restartCount,
					lastError: status.lastError ?? ''
				}),
				eventLimit
			);
		}
		return next;
	}

	if (status.state === 'starting') {
		next = {
			...next,
			phase: 'booting',
			currentAction: 'Starting local runtime processes...',
			startedAtMs: next.startedAtMs,
			apiReady: false,
			stoppingLockActive: false
		};
		if (statusChanged) {
			next = appendRuntimeStateEvent(
				next,
				'info',
				'runtime.state.starting',
				'Runtime status changed to starting',
				eventLimit
			);
		}
		return next;
	}

	if (status.state === 'stopped' && status.lastError?.trim()) {
		next = {
			...next,
			phase: 'fatal',
			currentAction: status.lastError.trim(),
			startedAtMs: nowMs,
			stoppingLockActive: false
		};
		if (statusChanged) {
			next = appendLifecycleEvent(
				next,
				createEvent('error', 'runtime.state.stopped.error', 'Runtime stopped with error', {
					lastError: status.lastError
				}),
				eventLimit
			);
		}
		return next;
	}

	if (status.state === 'stopped') {
		next = {
			...next,
			phase: 'booting',
			currentAction: 'Runtime stopped. Waiting for start command...',
			startedAtMs: next.startedAtMs,
			stoppingLockActive: false
		};
		// Do not emit a warning for the initial snapshot before auto-start.
		// This is an expected baseline state during desktop boot.
		if (statusChanged && previous !== null) {
			next = appendRuntimeStateEvent(
				next,
				'warn',
				'runtime.state.stopped',
				'Runtime status changed to stopped',
				eventLimit
			);
		}
		return next;
	}

	return next;
}

function appendRuntimeStateEvent(
	state: LifecycleState,
	level: LifecycleEvent['level'],
	code: string,
	message: string,
	eventLimit: number
): LifecycleState {
	return appendLifecycleEvent(state, createEvent(level, code, message), eventLimit);
}

function createEvent(
	level: LifecycleEvent['level'],
	code: string,
	message: string,
	meta?: LifecycleEvent['meta']
): LifecycleEvent {
	return {
		id: -1,
		atIso: new Date().toISOString(),
		level,
		code,
		message,
		meta
	};
}

export function appendLifecycleEvent(
	state: LifecycleState,
	event: LifecycleEvent,
	eventLimit: number = DEFAULT_EVENT_LIMIT
): LifecycleState {
	const assignedId = event.id > 0 ? event.id : state.nextEventId;
	const normalizedEvent: LifecycleEvent = {
		...event,
		id: assignedId,
		atIso: event.atIso || new Date().toISOString()
	};
	const events = [...state.events, normalizedEvent];
	if (events.length > eventLimit) {
		events.splice(0, events.length - eventLimit);
	}
	return {
		...state,
		nextEventId: assignedId + 1,
		events
	};
}
