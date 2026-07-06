import type { FastifyRequest } from "fastify";
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
        [BOOTSTRAP_API_QUERY_PARAM.ImageSourceField]?: string;
        [BOOTSTRAP_API_QUERY_PARAM.AnimationSourceField]?: string;
        standard?: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class ProbeCollectionContractHttpAdapter {
    constructor(
        private readonly probeCollectionContractPort: {
            probe(
                input: ProbeCollectionContractInput,
            ): MaybePromise<ProbeCollectionContractOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<ProbeCollectionContractRoute>,
    ) => {
        const input = this.mapRequestToInput(request);
        return this.probeCollectionContractPort.probe(input);
    };

    private mapRequestToInput(
        request: FastifyRequest<ProbeCollectionContractRoute>,
    ): ProbeCollectionContractInput {
        const address = mustString(
            request.query[BOOTSTRAP_API_QUERY_PARAM.Address],
            BOOTSTRAP_API_QUERY_PARAM.Address,
        );
        const standard =
            request.query[BOOTSTRAP_API_QUERY_PARAM.Standard]?.trim() ||
            "erc721";
        if (standard !== "erc721") {
            throw new ReadModelBadRequestError("Only erc721 is supported");
        }
        return {
            chainRef: request.params.chain_ref,
            address,
            standard,
            imageSourceField: optionalString(
                request.query[BOOTSTRAP_API_QUERY_PARAM.ImageSourceField],
            ),
            animationSourceField: optionalString(
                request.query[BOOTSTRAP_API_QUERY_PARAM.AnimationSourceField],
            ),
        };
    }
}

function mustString(value: unknown, field: string): string {
    if (typeof value !== "string" || !value.trim()) {
        throw new ReadModelBadRequestError(`${field} is required`);
    }
    return value.trim();
}

function optionalString(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") {
        throw new ReadModelBadRequestError("Expected string");
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}
