import { APP_COMMIT, APP_VERSION } from './app-version';
import { getFrontendBuildTarget } from './frontend-target';
import { getFrontendDeploymentMode, PUBLIC_COLLECTION_SCOPE } from './public-deployment';
import type { LifecycleEventMeta } from './lifecycle/core/types';

/** Selected compiled frontend settings, rather than the machine's current .env. */
export function appBuildContext(): LifecycleEventMeta {
	return {
		frontendVersion: APP_VERSION,
		frontendCommit: APP_COMMIT,
		frontendBuildTarget: getFrontendBuildTarget(),
		frontendDeploymentMode: getFrontendDeploymentMode(),
		publicChainRef: PUBLIC_COLLECTION_SCOPE?.chainRef ?? '',
		publicCollectionRef: PUBLIC_COLLECTION_SCOPE?.collectionRef ?? ''
	};
}
