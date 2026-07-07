import type { SettingsDefaultKey } from "./generated-settings-defaults.js";

// Env keys for public deployment routing and single-collection scope wiring.
export const PUBLIC_APP_DEPLOYMENT_ENV_KEY = {
    Mode: "PUBLIC_APP_DEPLOYMENT_MODE",
    ChainRef: "PUBLIC_APP_CHAIN_REF",
    CollectionRef: "PUBLIC_APP_COLLECTION_REF",
} as const satisfies Record<string, SettingsDefaultKey>;

// Deployment mode values shared by backend config parsing and frontend routing.
export const APP_DEPLOYMENT_MODE = {
    Standard: "standard",
    PublicSingleCollection: "public_single_collection",
} as const;

export type AppDeploymentMode =
    (typeof APP_DEPLOYMENT_MODE)[keyof typeof APP_DEPLOYMENT_MODE];

// Narrows external config text to the known deployment-mode vocabulary.
export function isAppDeploymentMode(value: string): value is AppDeploymentMode {
    return (
        value === APP_DEPLOYMENT_MODE.Standard ||
        value === APP_DEPLOYMENT_MODE.PublicSingleCollection
    );
}

// Public single-collection mode hides private/local operator routes and context.
export function isPublicSingleCollectionDeployment(
    mode: AppDeploymentMode,
): boolean {
    return mode === APP_DEPLOYMENT_MODE.PublicSingleCollection;
}
