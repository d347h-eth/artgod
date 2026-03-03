import type { LifecyclePhase } from './lifecycle/core/types';

export type AdminConsoleTab = 'lifecycle' | 'logs' | 'status';
export type StartupSurfaceMode = 'none' | 'admin-lifecycle';

export type StartupSurfacePolicy = {
	mode: StartupSurfaceMode;
	forceOpen: boolean;
	preferredTab: AdminConsoleTab | null;
};

export function resolveStartupSurfacePolicy(phase: LifecyclePhase): StartupSurfacePolicy {
	if (phase === 'booting' || phase === 'stopping' || phase === 'fatal') {
		return {
			mode: 'admin-lifecycle',
			forceOpen: true,
			preferredTab: 'lifecycle'
		};
	}

	return {
		mode: 'none',
		forceOpen: false,
		preferredTab: null
	};
}
