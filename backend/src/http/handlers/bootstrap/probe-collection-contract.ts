import type { FastifyRequest } from "fastify";
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
        const address = mustString(request.query.address, "address");
        const standard = request.query.standard?.trim() || "erc721";
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
