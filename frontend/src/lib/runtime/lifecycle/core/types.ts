import type { RuntimeStatus } from '../ports';

export type LifecyclePhase = 'booting' | 'fatal' | 'stopping' | 'ready';
export type LifecycleEventLevel = 'info' | 'warn' | 'error';

export type LifecycleEventMeta = Record<string, string | number | boolean>;

export type LifecycleEvent = {
	id: number;
	atIso: string;
	level: LifecycleEventLevel;
	code: string;
	message: string;
	meta?: LifecycleEventMeta;
};

export type LifecycleState = {
	phase: LifecyclePhase;
	currentAction: string;
	startedAtMs: number;
	apiReady: boolean;
	stoppingLockActive: boolean;
	nextEventId: number;
	events: LifecycleEvent[];
};

export type LifecycleConfig = {
	eventLimit: number;
};

export type LifecycleAction =
	| {
			type: 'BOOT_RESET';
			currentAction: string;
			startedAtMs: number;
		}
	| {
			type: 'SET_STOPPING';
			currentAction: string;
			startedAtMs: number;
		}
	| {
			type: 'SET_FATAL';
			currentAction: string;
			startedAtMs: number;
		}
	| {
			type: 'API_READY';
			startedAtMs: number;
		}
	| {
			type: 'APPEND_EVENT';
			event: LifecycleEvent;
		}
	| {
			type: 'APPLY_RUNTIME_STATUS';
			status: RuntimeStatus;
			previous: RuntimeStatus | null;
			startedAtMs: number;
		};
