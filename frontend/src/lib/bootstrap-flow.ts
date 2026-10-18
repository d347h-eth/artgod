import { BOOTSTRAP_STEP_KEY } from '@artgod/shared/bootstrap/pipeline';
import type { ApiBootstrapFlowStep } from './api-types';

// Row identities also label the accessible lists in the run-detail surface.
export const BOOTSTRAP_FLOW_ROW = {
	Required: 'required steps',
	OpenSea: 'OpenSea steps',
	Optional: 'optional steps'
} as const;

export const BOOTSTRAP_FLOW_ROWS = [
	BOOTSTRAP_FLOW_ROW.Required,
	BOOTSTRAP_FLOW_ROW.OpenSea,
	BOOTSTRAP_FLOW_ROW.Optional
] as const;

export function bootstrapFlowRow(step: ApiBootstrapFlowStep) {
	if (
		step.key === BOOTSTRAP_STEP_KEY.OpenSeaIdentity ||
		step.key === BOOTSTRAP_STEP_KEY.OpenSeaSnapshot ||
		step.key === BOOTSTRAP_STEP_KEY.OpenSeaReady
	)
		return BOOTSTRAP_FLOW_ROW.OpenSea;
	return step.blocking ? BOOTSTRAP_FLOW_ROW.Required : BOOTSTRAP_FLOW_ROW.Optional;
}
