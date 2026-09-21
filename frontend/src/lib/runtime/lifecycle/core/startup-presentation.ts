import {
	RECOVERY_FAILURE_REASONS,
	RECOVERY_TASKS,
	STARTUP_PHASES,
	type RuntimeStatus,
	type StartupActivity
} from '../ports';

/** Product language belongs here; the supervisor sends task identity and timing. */
export function startupAction(activity: StartupActivity): string {
	switch (activity.phase) {
		case STARTUP_PHASES.recovery:
			if (activity.task === RECOVERY_TASKS.sqliteCompaction) return 'Reclaiming storage…';
			if (activity.task === RECOVERY_TASKS.sqliteMaintenance) return 'Checking market data…';
			return activity.task === RECOVERY_TASKS.natsMaintenance
				? 'Checking queued work…'
				: 'Preparing local data…';
		case STARTUP_PHASES.cleanup:
			return 'Cleaning up startup processes…';
		case STARTUP_PHASES.services:
			return 'Starting local services…';
		case STARTUP_PHASES.backoff:
			return 'Waiting to restart local services…';
		case STARTUP_PHASES.preparing:
			return 'Preparing local services…';
	}
}

export function runtimeFailureMessage(status: RuntimeStatus): string {
	if (status.recoveryFailure) {
		return status.recoveryFailure.reason === RECOVERY_FAILURE_REASONS.timedOut
			? 'Startup preparation timed out. Open logs for details, then retry start.'
			: 'Startup preparation failed. Open logs for details, then retry start.';
	}
	return status.lastError?.trim() || 'Local services stopped. Retry start.';
}
