import { BOOTSTRAP_ACTION_LABEL as Action } from "@artgod/shared/bootstrap/operation-output";
import {
    HttpFetchRequestTimeoutError,
    HttpFetchStatusError,
} from "@artgod/shared/network/http-fetch-resilience";

// Keep upstream details in logs; report the failed resource and the recovery control.
export function bootstrapMetadataFetchFailure(
    error: unknown,
    sourceUri: string,
): string {
    return bootstrapResourceFailureMessage("Metadata", error, sourceUri);
}

export function bootstrapImageFetchFailure(
    error: unknown,
    sourceUri: string,
): string {
    return bootstrapResourceFailureMessage("Image", error, sourceUri);
}

function bootstrapResourceFailureMessage(
    resource: "Metadata" | "Image",
    error: unknown,
    sourceUri: string,
): string {
    const failure =
        error instanceof HttpFetchStatusError
            ? `${resource} download failed (HTTP ${error.status}).`
            : error instanceof HttpFetchRequestTimeoutError
              ? `${resource} download timed out.`
              : `${resource} could not be downloaded.`;
    const retry = resource === "Metadata" ? Action.Inspect : "estimate";
    const ipfs = sourceUri.startsWith("ipfs://") || isIpfsGatewayUrl(sourceUri);
    const recovery = ipfs
        ? `Check the IPFS gateway in Admin config, restart infra after changes, then press ${retry}.`
        : `Press ${retry} to retry, or choose another sample token ID and press ${Action.Inspect}.`;
    return `${failure} ${recovery}`;
}

function isIpfsGatewayUrl(uri: string): boolean {
    try {
        const url = new URL(uri);
        return (
            url.pathname.startsWith("/ipfs/") || url.hostname.includes(".ipfs.")
        );
    } catch {
        return false;
    }
}
