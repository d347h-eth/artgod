import { normalizeSlugRef } from '@artgod/shared/utils/ref-resolver';

export type FrontendDeploymentMode = 'standard' | 'public_single_collection';

const FRONTEND_DEPLOYMENT_MODE = normalizeDeploymentMode(
	(import.meta.env.PUBLIC_APP_DEPLOYMENT_MODE as string | undefined)?.trim() || ''
);

const RAW_PUBLIC_CHAIN_REF =
	(import.meta.env.PUBLIC_APP_CHAIN_REF as string | undefined)?.trim() || '';
const RAW_PUBLIC_COLLECTION_REF =
	(import.meta.env.PUBLIC_APP_COLLECTION_REF as string | undefined)?.trim() || '';

export const IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT =
	FRONTEND_DEPLOYMENT_MODE === 'public_single_collection';

export type PublicCollectionScope = {
	chainRef: string;
	collectionRef: string;
};

export const PUBLIC_COLLECTION_SCOPE: PublicCollectionScope | null =
	IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT &&
	RAW_PUBLIC_CHAIN_REF &&
	RAW_PUBLIC_COLLECTION_REF
		? {
				chainRef: normalizeSlugRef(RAW_PUBLIC_CHAIN_REF),
				collectionRef: normalizeSlugRef(RAW_PUBLIC_COLLECTION_REF)
			}
		: null;

export function getFrontendDeploymentMode(): FrontendDeploymentMode {
	return FRONTEND_DEPLOYMENT_MODE;
}

export function matchesPublicCollectionRoute(
	chainRef: string,
	collectionRef: string
): boolean {
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
	if (value === 'public_single_collection') {
		return 'public_single_collection';
	}
	return 'standard';
}
