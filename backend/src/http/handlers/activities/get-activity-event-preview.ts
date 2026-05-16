import type { FastifyRequest } from "fastify";
import { ACTIVITY_EVENT_PREVIEW_QUERY_PARAMS } from "@artgod/shared/types";
import {
    ARTGOD_SPAN_ATTRIBUTE,
    ARTGOD_TRACE_ATTRIBUTE_VALUE,
} from "@artgod/shared/observability";
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

const ACTIVITY_EVENT_PREVIEW_TRACE_VALUE = {
    None: ARTGOD_TRACE_ATTRIBUTE_VALUE.None,
    Invalid: ARTGOD_TRACE_ATTRIBUTE_VALUE.Invalid,
} as const;

const ACTIVITY_EVENT_PREVIEW_SPAN_ATTRIBUTE = {
    ActivityId: ARTGOD_SPAN_ATTRIBUTE.ActivityId,
    RenderMode: ARTGOD_SPAN_ATTRIBUTE.ActivityRenderMode,
    RenderModePresent: ARTGOD_SPAN_ATTRIBUTE.ActivityRenderModePresent,
} as const;

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
    const safeActivityId = Number.isSafeInteger(activityId)
        ? activityId
        : undefined;
    return {
        [ACTIVITY_EVENT_PREVIEW_SPAN_ATTRIBUTE.ActivityId]: safeActivityId,
        [ACTIVITY_EVENT_PREVIEW_SPAN_ATTRIBUTE.RenderMode]:
            normalizeRenderModeAttribute(renderMode),
        [ACTIVITY_EVENT_PREVIEW_SPAN_ATTRIBUTE.RenderModePresent]:
            Boolean(renderMode),
    };
}

function normalizeRenderModeAttribute(value: string | null): string {
    if (!value) return ACTIVITY_EVENT_PREVIEW_TRACE_VALUE.None;
    return /^[a-z0-9_.-]{1,64}$/i.test(value)
        ? value.toLowerCase()
        : ACTIVITY_EVENT_PREVIEW_TRACE_VALUE.Invalid;
}
