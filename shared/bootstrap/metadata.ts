import { BOOTSTRAP_ACTION_LABEL as Action } from "./operation-output.js";
import { selectTokenMetadataImageSource } from "../media/token-metadata-image-source.js";
import { selectTokenMetadataAnimationSource } from "../media/token-metadata-animation-source.js";
import { resolveTokenResourceUri } from "../media/token-resource-uri.js";

/** Re-select fields from already bounded text without repeating RPC or downloads. */
export function inspectBootstrapMetadata(input: {
    text: string | null;
    imageSourceField?: string | null;
    animationSourceField?: string | null;
    ipfsGatewayOrigin: string;
}) {
    const empty = {
        name: null,
        imageSourceField: null,
        image: null,
        animationSourceField: null,
        animationUrl: null,
    };
    if (input.text === null) return { ...empty, error: null };
    try {
        const raw: unknown = JSON.parse(input.text);
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
            throw new Error("Metadata must be a JSON object");
        const metadata = raw as Record<string, unknown>;
        const image = selectTokenMetadataImageSource({
            metadata,
            requestedField: input.imageSourceField,
            ipfsGatewayOrigin: input.ipfsGatewayOrigin,
        });
        const animation = selectTokenMetadataAnimationSource({
            metadata,
            requestedField: input.animationSourceField,
            ipfsGatewayOrigin: input.ipfsGatewayOrigin,
        });
        return {
            name: typeof metadata.name === "string" ? metadata.name : null,
            imageSourceField: image?.field ?? null,
            image: resolveTokenResourceUri(image?.value ?? null, {
                ipfsGatewayOrigin: input.ipfsGatewayOrigin,
            }),
            animationSourceField: animation?.field ?? null,
            animationUrl: resolveTokenResourceUri(animation?.value ?? null, {
                ipfsGatewayOrigin: input.ipfsGatewayOrigin,
            }),
            error: null,
        };
    } catch {
        return {
            ...empty,
            error: `Metadata is not a JSON object. Choose another sample token ID, then press ${Action.Inspect}.`,
        };
    }
}
