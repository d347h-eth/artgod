import type { FastifyRequest } from "fastify";
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
            "artgod.activity.id": 33,
            "artgod.activity.render_mode": "artifact",
            "artgod.activity.render_mode_present": true,
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
            "artgod.activity.id": undefined,
            "artgod.activity.render_mode": "invalid",
            "artgod.activity.render_mode_present": true,
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
