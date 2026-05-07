import type { FastifyRequest } from "fastify";
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
            getSearchParams(request).get("render_mode")?.trim() || undefined;
        return {
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            activityId,
            renderMode,
        };
    }
}
