import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';
import {
	RECOVERY_HARNESS_SCENARIOS,
	RECOVERY_HARNESS_SCENARIO_KEY,
	type RecoveryHarnessScenario
} from '$lib/e2e/runtime-recovery-fixture';
import type { PageLoad } from './$types';

export const ssr = false;
export const load: PageLoad = ({ url }) => {
	if (!dev) throw error(404, 'Not found');
	const requested = url.searchParams.get(RECOVERY_HARNESS_SCENARIO_KEY) as RecoveryHarnessScenario;
	return {
		scenario: Object.values(RECOVERY_HARNESS_SCENARIOS).includes(requested)
			? requested
			: RECOVERY_HARNESS_SCENARIOS.manual
	};
};
