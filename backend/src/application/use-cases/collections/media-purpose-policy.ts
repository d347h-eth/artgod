import {
    COLLECTION_MEDIA_PURPOSE,
    COLLECTION_MEDIA_SOURCE,
    mediaPurposePolicySourceForPurpose,
    type MediaPurposePolicyConfig,
} from "@artgod/shared/types";
import type {
    TokenDetail,
    TokenMediaPreview,
} from "@artgod/shared/types/browse";

// Applies collection media-source preference to iframe-backed token surfaces.
export function applyMediaPurposePolicyToTokenMedia<
    T extends TokenDetail | TokenMediaPreview,
>(input: {
    token: T;
    config: MediaPurposePolicyConfig;
    purpose:
        | typeof COLLECTION_MEDIA_PURPOSE.FullscreenPreview
        | typeof COLLECTION_MEDIA_PURPOSE.TokenDetail;
}): T {
    const source = mediaPurposePolicySourceForPurpose(
        input.config,
        input.purpose,
    );
    if (source !== COLLECTION_MEDIA_SOURCE.Image || !input.token.image) {
        return input.token;
    }

    return {
        ...input.token,
        animationUrl: null,
    };
}
