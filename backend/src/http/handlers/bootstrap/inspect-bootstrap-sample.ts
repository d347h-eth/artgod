import type { FastifyRequest, FastifyReply } from "fastify";
import {
    BOOTSTRAP_OPERATION,
    type BootstrapOutputReporter,
} from "@artgod/shared/bootstrap/operation-output";
import { bootstrapOperationResponse } from "./operation-response.js";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import type {
    BootstrapSampleInspectionRequest,
    BootstrapSampleInspectionResponse,
} from "@artgod/shared/bootstrap/probe";

export type InspectBootstrapSampleRoute = {
    Params: { chain_ref: string };
    Body: BootstrapSampleInspectionRequest;
};

export class InspectBootstrapSampleHttpAdapter {
    constructor(
        private readonly inspector: {
            inspect(
                input: BootstrapSampleInspectionRequest & { chainRef: string },
                report?: BootstrapOutputReporter,
            ): Promise<BootstrapSampleInspectionResponse>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<InspectBootstrapSampleRoute>,
        reply: FastifyReply,
    ) => {
        const body = request.body;
        if (!body || typeof body.address !== "string")
            throw new ReadModelBadRequestError("address is required");
        return bootstrapOperationResponse(
            request,
            reply,
            BOOTSTRAP_OPERATION.Inspect,
            (report) =>
                this.inspector.inspect(
                    {
                        chainRef: request.params.chain_ref,
                        address: body.address,
                        requestedTokenId: body.requestedTokenId,
                        discoveredTokenId: body.discoveredTokenId,
                        observation: body.observation,
                        scope: body.scope,
                    },
                    report,
                ),
        );
    };
}
