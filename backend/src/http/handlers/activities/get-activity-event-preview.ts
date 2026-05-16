import type { FastifyRequest } from "fastify";
import { ACTIVITY_EVENT_PREVIEW_QUERY_PARAMS } from "@artgod/shared/types";
import type { SpanAttributes } from "@artgod/shared/observability/apm";
import type {
    GetActivityEventPreviewInput,
    GetActivityEventPreviewOutput,
} from "../../../application/use-cases/activities/get-activity-event-preview.js";
import { getSearchParams } from "../../common/request-query.js";

export type GetActivityEventPreviewRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
        activity_id: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class GetActivityEventPreviewHttpAdapter {
    constructor(
        readonly getActivityEventPreviewPort: {
            getActivityEventPreview(
                input: GetActivityEventPreviewInput,
            ): MaybePromise<GetActivityEventPreviewOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<GetActivityEventPreviewRoute>,
    ) => {
        const output =
            await this.getActivityEventPreviewPort.getActivityEventPreview(
                this.mapRequestToInput(request),
            );
        return output;
    };

    private mapRequestToInput(
        request: FastifyRequest<GetActivityEventPreviewRoute>,
    ): GetActivityEventPreviewInput {
        const activityId = Number(request.params.activity_id);
        const renderMode =
            getSearchParams(request)
                .get(ACTIVITY_EVENT_PREVIEW_QUERY_PARAMS.RenderMode)
                ?.trim() || undefined;
        return {
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            activityId,
            renderMode,
        };
    }
}

// Captures preview request shape without turning raw params into metric labels.
export function getActivityEventPreviewSpanAttributes(
    request: FastifyRequest<GetActivityEventPreviewRoute>,
): SpanAttributes {
    const renderMode =
        getSearchParams(request)
            .get(ACTIVITY_EVENT_PREVIEW_QUERY_PARAMS.RenderMode)
            ?.trim() || null;
    const activityId = Number(request.params.activity_id);
    return {
        "artgod.activity.id": Number.isSafeInteger(activityId)
            ? activityId
            : undefined,
        "artgod.activity.render_mode": normalizeRenderModeAttribute(renderMode),
        "artgod.activity.render_mode_present": Boolean(renderMode),
    };
}

function normalizeRenderModeAttribute(value: string | null): string {
    if (!value) return "none";
    return /^[a-z0-9_.-]{1,64}$/i.test(value) ? value.toLowerCase() : "invalid";
}
