import {
	APP_DEPLOYMENT_MODE,
	PUBLIC_APP_DEPLOYMENT_ENV_KEY,
	isAppDeploymentMode,
	isPublicSingleCollectionDeployment,
	type AppDeploymentMode
} from '@artgod/shared/config/deployment';
import { normalizeSlugRef } from '@artgod/shared/utils/ref-resolver';

export type FrontendDeploymentMode = AppDeploymentMode;

const FRONTEND_DEPLOYMENT_MODE = normalizeDeploymentMode(
	readPublicDeploymentEnv(PUBLIC_APP_DEPLOYMENT_ENV_KEY.Mode)
);

const RAW_PUBLIC_CHAIN_REF = readPublicDeploymentEnv(PUBLIC_APP_DEPLOYMENT_ENV_KEY.ChainRef);
const RAW_PUBLIC_COLLECTION_REF = readPublicDeploymentEnv(
	PUBLIC_APP_DEPLOYMENT_ENV_KEY.CollectionRef
);

export const IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT =
	isPublicSingleCollectionDeployment(FRONTEND_DEPLOYMENT_MODE);

export type PublicCollectionScope = {
	chainRef: string;
	collectionRef: string;
};

export const PUBLIC_COLLECTION_SCOPE: PublicCollectionScope | null =
	IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT && RAW_PUBLIC_CHAIN_REF && RAW_PUBLIC_COLLECTION_REF
		? {
				chainRef: normalizeSlugRef(RAW_PUBLIC_CHAIN_REF),
				collectionRef: normalizeSlugRef(RAW_PUBLIC_COLLECTION_REF)
			}
		: null;

export function getFrontendDeploymentMode(): FrontendDeploymentMode {
	return FRONTEND_DEPLOYMENT_MODE;
}

export function matchesPublicCollectionRoute(chainRef: string, collectionRef: string): boolean {
	if (!PUBLIC_COLLECTION_SCOPE) return false;
	return (
		normalizeSlugRef(chainRef) === PUBLIC_COLLECTION_SCOPE.chainRef &&
		normalizeSlugRef(collectionRef) === PUBLIC_COLLECTION_SCOPE.collectionRef
	);
}

export function publicCollectionTokensPath(): string {
	return '/';
}

export function publicCollectionActivityPath(): string {
	return '/activity';
}

export function publicCollectionBiddingPath(): string {
	return '/bidding';
}

export function publicCollectionHoldersPath(): string {
	return '/holders';
}

export function publicCollectionBlockspacePath(): string {
	return '/blockspace';
}

export function publicCollectionExtensionPagePath(extensionKey: string, pageRef: string): string {
	return `/extensions/${encodeURIComponent(extensionKey)}/${encodeURIComponent(pageRef)}`;
}

export function publicCollectionOwnerTokensPath(ownerRef: string): string {
	return `/holders/${encodeURIComponent(ownerRef)}`;
}

export function publicCollectionTokenDetailPath(tokenRef: string): string {
	return `/${encodeURIComponent(tokenRef)}`;
}

export function collectionBiddingNavigationVisibilityForDeployment(): {
	showOffers: boolean;
} {
	return {
		showOffers: true
	};
}

function normalizeDeploymentMode(value: string): FrontendDeploymentMode {
	if (isAppDeploymentMode(value)) {
		return value;
	}
	return APP_DEPLOYMENT_MODE.Standard;
}

function readPublicDeploymentEnv(key: string): string {
	return ((import.meta.env as Record<string, string | undefined>)[key] ?? '').trim();
}
