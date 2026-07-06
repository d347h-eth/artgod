import {
    COLLECTION_MEDIA_PURPOSE,
    COLLECTION_MEDIA_SOURCE,
    mediaPurposePolicySourceForPurpose,
    type CollectionMediaSource,
    type MediaPurposePolicyConfig,
} from "@artgod/shared/types";
import type {
    TokenCard,
    TokenDetail,
    TokenMediaPreview,
} from "@artgod/shared/types/browse";

type TokenMediaFields = {
    image: string | null;
    animationUrl: string | null;
};

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

// Applies collection media-source preference to image-backed token cards.
export function applyMediaPurposePolicyToTokenCards(input: {
    tokens: TokenCard[];
    config: MediaPurposePolicyConfig;
}): TokenCard[] {
    const source = mediaPurposePolicySourceForPurpose(
        input.config,
        COLLECTION_MEDIA_PURPOSE.TokenCard,
    );
    if (source !== COLLECTION_MEDIA_SOURCE.AnimationUrl) {
        return input.tokens;
    }

    return input.tokens.map((token) => ({
        ...token,
        image: mediaValueForSource(token, source) ?? token.image,
    }));
}

function mediaValueForSource(
    token: TokenMediaFields,
    source: CollectionMediaSource,
): string | null {
    if (source === COLLECTION_MEDIA_SOURCE.AnimationUrl) {
        return token.animationUrl;
    }
    return token.image;
}
