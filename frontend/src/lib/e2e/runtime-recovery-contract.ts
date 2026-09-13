export const RECOVERY_HARNESS_PATH = '/e2e-harness/admin/runtime';
export const RECOVERY_HARNESS_SCENARIOS = {
	manual: 'manual',
	autoStart: 'autoStart',
	attached: 'attached',
	drawer: 'drawer'
} as const;
export const RECOVERY_HARNESS_SCENARIO_KEY = 'scenario';
export type RecoveryHarnessScenario =
	(typeof RECOVERY_HARNESS_SCENARIOS)[keyof typeof RECOVERY_HARNESS_SCENARIOS];
