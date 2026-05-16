import type { FastifyRequest } from "fastify";
import {
    ARTGOD_SPAN_ATTRIBUTE,
    ARTGOD_TRACE_ATTRIBUTE_VALUE,
} from "@artgod/shared/observability";
import { describe, expect, it } from "vitest";
import {
    getActivityEventPreviewSpanAttributes,
    type GetActivityEventPreviewRoute,
} from "./get-activity-event-preview.js";

describe("get activity event preview span attributes", () => {
    it("summarizes preview request shape", () => {
        const attributes = getActivityEventPreviewSpanAttributes(
            request(
                "/api/ethereum/terraforms/activity/33/preview?render_mode=Artifact",
                "33",
            ),
        );

        expect(attributes).toEqual({
            [ARTGOD_SPAN_ATTRIBUTE.ActivityId]: 33,
            [ARTGOD_SPAN_ATTRIBUTE.ActivityRenderMode]: "artifact",
            [ARTGOD_SPAN_ATTRIBUTE.ActivityRenderModePresent]: true,
        });
    });

    it("marks arbitrary render modes as invalid", () => {
        const attributes = getActivityEventPreviewSpanAttributes(
            request(
                "/api/ethereum/terraforms/activity/not-a-number/preview?render_mode=../../raw",
                "not-a-number",
            ),
        );

        expect(attributes).toEqual({
            [ARTGOD_SPAN_ATTRIBUTE.ActivityId]: undefined,
            [ARTGOD_SPAN_ATTRIBUTE.ActivityRenderMode]:
                ARTGOD_TRACE_ATTRIBUTE_VALUE.Invalid,
            [ARTGOD_SPAN_ATTRIBUTE.ActivityRenderModePresent]: true,
        });
    });
});

function request(
    url: string,
    activityId: string,
): FastifyRequest<GetActivityEventPreviewRoute> {
    return {
        raw: {
            url,
        },
        params: {
            activity_id: activityId,
        },
    } as FastifyRequest<GetActivityEventPreviewRoute>;
}
