import type { FastifyRequest, FastifyReply } from "fastify";
import {
    BOOTSTRAP_OPERATION,
    type BootstrapOutputReporter,
} from "@artgod/shared/bootstrap/operation-output";
import { bootstrapOperationResponse } from "./operation-response.js";
import { BOOTSTRAP_API_QUERY_PARAM } from "@artgod/shared/http/bootstrap-routes";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import type {
    ProbeCollectionContractInput,
    ProbeCollectionContractOutput,
} from "../../../application/use-cases/bootstrap/probe-collection-contract.js";

export type ProbeCollectionContractRoute = {
    Params: {
        chain_ref: string;
    };
    Querystring: {
        address?: string;
        standard?: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class ProbeCollectionContractHttpAdapter {
    constructor(
        private readonly probeCollectionContractPort: {
            probe(
                input: ProbeCollectionContractInput,
                report?: BootstrapOutputReporter,
            ): MaybePromise<ProbeCollectionContractOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<ProbeCollectionContractRoute>,
        reply: FastifyReply,
    ) => {
        const input = this.mapRequestToInput(request);
        return bootstrapOperationResponse(
            request,
            reply,
            BOOTSTRAP_OPERATION.Probe,
            (report) => this.probeCollectionContractPort.probe(input, report),
        );
    };

    private mapRequestToInput(
        request: FastifyRequest<ProbeCollectionContractRoute>,
    ): ProbeCollectionContractInput {
        const address = mustString(
            request.query[BOOTSTRAP_API_QUERY_PARAM.Address],
            BOOTSTRAP_API_QUERY_PARAM.Address,
        );
        const rawStandard = request.query[BOOTSTRAP_API_QUERY_PARAM.Standard];
        if (rawStandard !== undefined && typeof rawStandard !== "string") {
            throw new ReadModelBadRequestError("Only erc721 is supported");
        }
        const standard = rawStandard?.trim() || "erc721";
        if (standard !== "erc721") {
            throw new ReadModelBadRequestError("Only erc721 is supported");
        }
        return {
            chainRef: request.params.chain_ref,
            address,
            standard,
        };
    }
}

function mustString(value: unknown, field: string): string {
    if (typeof value !== "string" || !value.trim()) {
        throw new ReadModelBadRequestError(`${field} is required`);
    }
    return value.trim();
}
