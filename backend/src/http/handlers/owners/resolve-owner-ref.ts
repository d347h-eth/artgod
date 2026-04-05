import type { FastifyRequest } from "fastify";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import type {
    ResolveOwnerRefInput,
    ResolveOwnerRefOutput,
} from "../../../application/use-cases/owners/resolve-owner-ref.js";
import { getSearchParams } from "../../common/request-query.js";

type MaybePromise<T> = T | Promise<T>;

export type ResolveOwnerRefRoute = {
    Params: {
        chain_ref: string;
    };
};

export class ResolveOwnerRefHttpAdapter {
    constructor(
        readonly resolveOwnerRefPort: {
            resolveOwnerRef(
                input: ResolveOwnerRefInput,
            ): MaybePromise<ResolveOwnerRefOutput>;
        },
    ) {}

    readonly handle = async (request: FastifyRequest<ResolveOwnerRefRoute>) => {
        const output = await this.resolveOwnerRefPort.resolveOwnerRef(
            this.mapRequestToInput(request),
        );
        return this.mapOutputToResponse(output);
    };

    private mapRequestToInput(
        request: FastifyRequest<ResolveOwnerRefRoute>,
    ): ResolveOwnerRefInput {
        const value = getSearchParams(request).get("value")?.trim();
        if (!value) {
            throw new ReadModelBadRequestError("Missing owner ref value");
        }
        return {
            chainRef: request.params.chain_ref,
            value,
        };
    }

    private mapOutputToResponse(
        output: ResolveOwnerRefOutput,
    ): ResolveOwnerRefOutput {
        return output;
    }
}
