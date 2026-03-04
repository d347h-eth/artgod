import type { FastifyRequest } from "fastify";
import type { BootstrapStatusOutput } from "../../../application/use-cases/bootstrap/types.js";

export type GetBootstrapStatusRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class GetBootstrapStatusHttpAdapter {
    constructor(
        private readonly getBootstrapStatusPort: {
            getStatus(input: {
                chainRef: string;
                collectionRef: string;
            }): MaybePromise<BootstrapStatusOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<GetBootstrapStatusRoute>,
    ) => {
        const output = await this.getBootstrapStatusPort.getStatus({
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
        });
        return output;
    };
}
